import {
  CommandId,
  EventId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import {
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  ProviderInstanceNotFoundError,
  ProviderSessionNotFoundError,
  ProviderUnsupportedError,
  ProviderValidationError,
} from "../../provider/Errors.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProjectionTurnRetractionRepositoryLive } from "../../persistence/Layers/ProjectionTurnRetractions.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import {
  type ProjectionTurnRetraction,
  ProjectionTurnRetractionRepository,
} from "../../persistence/Services/ProjectionTurnRetractions.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  TurnRetractionReactor,
  type TurnRetractionReactorShape,
} from "../Services/TurnRetractionReactor.ts";

type RetractionStage =
  | "eligibility"
  | "interrupt"
  | "settlement"
  | "provider-rollback"
  | "checkpoint-restore"
  | "cleanup";

type StageFailure = {
  readonly stage: RetractionStage;
  readonly retryable: boolean;
  readonly detail: string;
  readonly silent?: boolean;
};

const terminalProviderErrorSchemas = [
  ProviderValidationError,
  ProviderUnsupportedError,
  ProviderInstanceNotFoundError,
  ProviderSessionNotFoundError,
  ProviderAdapterValidationError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterSessionClosedError,
] as const;
const isTerminalProviderError = (error: unknown): boolean =>
  terminalProviderErrorSchemas.some((errorSchema) => Schema.is(errorSchema)(error));

const failureDetail = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isProviderAdapterValidationError = Schema.is(ProviderAdapterValidationError);
const isUnavailableRetainedBoundary = (error: unknown): boolean =>
  isProviderAdapterValidationError(error) &&
  error.operation === "rollbackThreadTo" &&
  /^Provider history has \d+ turns, below retained boundary \d+\.$/.test(error.issue);

export class TurnRetractionRetryTicks extends Context.Reference<Stream.Stream<void>>(
  "t3/orchestration/Layers/TurnRetractionReactor/TurnRetractionRetryTicks",
  {
    defaultValue: () => Stream.tick(Duration.seconds(30)).pipe(Stream.drop(1)),
  },
) {}

export class TurnRetractionInterruptRetryTicks extends Context.Reference<Stream.Stream<void>>(
  "t3/orchestration/Layers/TurnRetractionReactor/TurnRetractionInterruptRetryTicks",
  {
    defaultValue: () => Stream.tick(Duration.seconds(2)).pipe(Stream.drop(1)),
  },
) {}

export class TurnRetractionInterruptTimeout extends Context.Reference<Duration.Input>(
  "t3/orchestration/Layers/TurnRetractionReactor/TurnRetractionInterruptTimeout",
  {
    defaultValue: () => Duration.seconds(15),
  },
) {}

export class TurnRetractionInterruptRetryCadence extends Context.Reference<Duration.Input>(
  "t3/orchestration/Layers/TurnRetractionReactor/TurnRetractionInterruptRetryCadence",
  {
    defaultValue: () => Duration.seconds(2),
  },
) {}

export const makeTurnRetractionReactor = Effect.gen(function* () {
  const retryTicks = yield* TurnRetractionRetryTicks;
  const interruptRetryTicks = yield* TurnRetractionInterruptRetryTicks;
  const interruptTimeout = yield* TurnRetractionInterruptTimeout;
  const interruptRetryCadence = yield* TurnRetractionInterruptRetryCadence;
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const turnRetractions = yield* ProjectionTurnRetractionRepository;
  const turns = yield* ProjectionTurnRepository;
  const providerService = yield* ProviderService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const interruptAttemptsByRequest = new Map<
    string,
    Map<string, { readonly attempt: number; readonly issuedAtMillis: number }>
  >();
  const interruptThreadIdsByRequest = new Map<string, ThreadId>();

  const clearIssuedInterrupts = (requestId: string) => {
    interruptAttemptsByRequest.delete(requestId);
    interruptThreadIdsByRequest.delete(requestId);
  };
  const readInterruptAttempt = (requestId: string, turnId: TurnId) =>
    interruptAttemptsByRequest.get(requestId)?.get(turnId);
  const markInterruptIssued = (
    requestId: string,
    threadId: ThreadId,
    turnId: TurnId,
    issuedAtMillis: number,
  ) => {
    const attempts = interruptAttemptsByRequest.get(requestId) ?? new Map();
    const attempt = (attempts.get(turnId)?.attempt ?? 0) + 1;
    attempts.set(turnId, { attempt, issuedAtMillis });
    interruptAttemptsByRequest.set(requestId, attempts);
    interruptThreadIdsByRequest.set(requestId, threadId);
    return attempt;
  };
  const clearIssuedInterrupt = (requestId: string, turnId: TurnId) => {
    const attempts = interruptAttemptsByRequest.get(requestId);
    attempts?.delete(turnId);
    if (attempts?.size === 0) {
      interruptAttemptsByRequest.delete(requestId);
      interruptThreadIdsByRequest.delete(requestId);
    }
  };

  const commandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const eventId = crypto.randomUUIDv4.pipe(Effect.map(EventId.make));
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const logConvergence = (
    row: ProjectionTurnRetraction,
    stage: RetractionStage,
    outcome: "completed" | "failed" | "pending" | "skipped",
    fields: {
      readonly action?: string;
      readonly reason?: string;
      readonly attempt?: number;
    } = {},
  ) =>
    Effect.logInfo("turn retraction convergence evaluated", {
      threadId: row.threadId,
      requestId: row.requestId,
      stage,
      outcome,
      ...fields,
    });

  const appendTerminalFailure = Effect.fn("appendTerminalRetractionFailure")(function* (
    row: ProjectionTurnRetraction,
    failure: StageFailure,
  ) {
    const createdAt = yield* nowIso;
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* commandId("turn-retract-failed"),
      threadId: row.threadId,
      activity: {
        id: yield* eventId,
        tone: "error",
        kind: "turn.retract.failed",
        summary: "Message retract failed",
        payload: {
          requestId: row.requestId,
          messageId: row.messageId,
          stage: failure.stage,
          retryable: failure.retryable,
          detail: failure.detail,
          ...(failure.silent ? { silent: true } : {}),
        },
        turnId: row.targetTurnId,
        createdAt,
      },
      createdAt,
    });
  });

  const resolveTargetTurnId = Effect.fn("resolveRetractionTargetTurnId")(function* (
    row: ProjectionTurnRetraction,
  ) {
    if (row.targetTurnId !== null) {
      return row.targetTurnId;
    }
    const projectedTurns = yield* turns.listByThreadId({ threadId: row.threadId });
    return (
      projectedTurns.find((turn) => turn.turnId !== null && turn.pendingMessageId === row.messageId)
        ?.turnId ?? null
    );
  });

  const restoreFilesystem = Effect.fn("restoreRetractionFilesystem")(function* (
    row: ProjectionTurnRetraction,
    captureMissingBaseline: boolean,
  ): Effect.fn.Return<void, StageFailure> {
    const thread = yield* projectionSnapshotQuery.getThreadDetailById(row.threadId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.mapError((error) => ({
        stage: "checkpoint-restore" as const,
        retryable: true,
        detail: failureDetail(error),
      })),
    );
    if (!thread) {
      return yield* Effect.fail({
        stage: "eligibility" as const,
        retryable: false,
        detail: `Thread '${row.threadId}' is unavailable while retracting the message.`,
      });
    }
    const project = yield* projectionSnapshotQuery.getProjectShellById(thread.projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.mapError((error) => ({
        stage: "checkpoint-restore" as const,
        retryable: true,
        detail: failureDetail(error),
      })),
    );
    const cwd = resolveThreadWorkspaceCwd({
      thread,
      projects: project ? [project] : [],
    });
    if (!cwd) return;

    const isGit = yield* checkpointStore.isGitRepository(cwd).pipe(
      Effect.mapError((error) => ({
        stage: "checkpoint-restore" as const,
        retryable: true,
        detail: failureDetail(error),
      })),
    );
    if (!isGit) return;

    let baselineExists = yield* checkpointStore
      .hasCheckpointRef({ cwd, checkpointRef: row.baselineCheckpointRef })
      .pipe(
        Effect.mapError((error) => ({
          stage: "checkpoint-restore" as const,
          retryable: true,
          detail: failureDetail(error),
        })),
      );
    if (!baselineExists && captureMissingBaseline) {
      yield* checkpointStore
        .captureCheckpoint({
          cwd,
          checkpointRef: row.baselineCheckpointRef,
        })
        .pipe(
          Effect.mapError((error) => ({
            stage: "checkpoint-restore" as const,
            retryable: true,
            detail: failureDetail(error),
          })),
        );
      baselineExists = true;
    }
    if (!baselineExists) {
      return yield* Effect.fail({
        stage: "checkpoint-restore" as const,
        retryable: false,
        detail: `Filesystem baseline '${row.baselineCheckpointRef}' is unavailable.`,
      });
    }

    const restored = yield* checkpointStore
      .restoreCheckpoint({
        cwd,
        checkpointRef: row.baselineCheckpointRef,
        fallbackToHead: row.baselineTurnCount === 0,
      })
      .pipe(
        Effect.mapError((error) => ({
          stage: "checkpoint-restore" as const,
          retryable: true,
          detail: failureDetail(error),
        })),
      );
    if (!restored) {
      return yield* Effect.fail({
        stage: "checkpoint-restore" as const,
        retryable: false,
        detail: `Filesystem baseline '${row.baselineCheckpointRef}' could not be restored.`,
      });
    }
    yield* workspaceEntries.refresh(cwd).pipe(
      Effect.mapError((error) => ({
        stage: "checkpoint-restore" as const,
        retryable: true,
        detail: failureDetail(error),
      })),
    );
  });

  const dispatchCompletion = Effect.fn("dispatchTurnRetractionCompletion")(function* (
    row: ProjectionTurnRetraction,
    targetTurnId: TurnId | null,
  ): Effect.fn.Return<void, StageFailure> {
    const createdAt = yield* nowIso;
    yield* orchestrationEngine
      .dispatch({
        type: "thread.turn.retract.complete",
        commandId: yield* commandId("turn-retract-complete").pipe(
          Effect.mapError((error) => ({
            stage: "cleanup" as const,
            retryable: true,
            detail: failureDetail(error),
          })),
        ),
        threadId: row.threadId,
        requestId: row.requestId,
        ...(targetTurnId !== null ? { targetTurnId } : {}),
        createdAt,
      })
      .pipe(
        Effect.mapError((error) => ({
          stage: "cleanup" as const,
          retryable: true,
          detail: failureDetail(error),
        })),
      );
  });

  const converge = Effect.fn("convergeTurnRetraction")(function* (
    requestedRow: ProjectionTurnRetraction,
  ): Effect.fn.Return<void, StageFailure> {
    const current = yield* turnRetractions
      .getByRequestId({ requestId: requestedRow.requestId })
      .pipe(
        Effect.mapError((error) => ({
          stage: "eligibility" as const,
          retryable: true,
          detail: failureDetail(error),
        })),
      );
    if (Option.isNone(current) || current.value.status !== "requested") {
      clearIssuedInterrupts(requestedRow.requestId);
      yield* logConvergence(requestedRow, "eligibility", "skipped", {
        reason: Option.isNone(current)
          ? "retraction row no longer exists"
          : `retraction status is '${current.value.status}'`,
      });
      return;
    }
    let row = current.value;

    if (row.providerSendState === "unclaimed") {
      yield* turnRetractions
        .cancelPendingProviderSend({ threadId: row.threadId, messageId: row.messageId })
        .pipe(
          Effect.mapError((error) => ({
            stage: "eligibility" as const,
            retryable: true,
            detail: failureDetail(error),
          })),
        );
      const reconciled = yield* turnRetractions.getByRequestId({ requestId: row.requestId }).pipe(
        Effect.mapError((error) => ({
          stage: "eligibility" as const,
          retryable: true,
          detail: failureDetail(error),
        })),
      );
      if (Option.isNone(reconciled) || reconciled.value.status !== "requested") {
        clearIssuedInterrupts(row.requestId);
        yield* logConvergence(row, "eligibility", "skipped", {
          action: "cancel-provider-send",
          reason: Option.isNone(reconciled)
            ? "retraction row disappeared while cancelling provider send"
            : `retraction status became '${reconciled.value.status}' while cancelling provider send`,
        });
        return;
      }
      row = reconciled.value;
    }

    const targetTurnId = yield* resolveTargetTurnId(row).pipe(
      Effect.mapError((error) => ({
        stage: "settlement" as const,
        retryable: true,
        detail: failureDetail(error),
      })),
    );

    if (row.providerSendState === "cancelled") {
      yield* restoreFilesystem(row, true);
      yield* dispatchCompletion(row, targetTurnId);
      clearIssuedInterrupts(row.requestId);
      yield* logConvergence(row, "cleanup", "completed", {
        action: "restore-filesystem-and-complete-cancelled-send",
      });
      return;
    }

    const thread = yield* projectionSnapshotQuery.getThreadDetailById(row.threadId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.mapError((error) => ({
        stage: "settlement" as const,
        retryable: true,
        detail: failureDetail(error),
      })),
    );
    if (!thread) {
      return yield* Effect.fail({
        stage: "eligibility" as const,
        retryable: false,
        detail: `Thread '${row.threadId}' is unavailable while retracting the message.`,
      });
    }

    const sessionWasActive =
      thread.session?.status === "starting" || thread.session?.status === "running";
    if (
      thread.session?.status === "starting" ||
      (thread.session?.status === "running" && thread.session.activeTurnId === null)
    ) {
      yield* logConvergence(row, "settlement", "pending", {
        action: "awaiting-turn-start",
        reason: `projected session is '${thread.session.status}' with no interruptible active turn`,
      });
      return;
    }
    if (thread.session?.status === "running") {
      const activeTurnId = thread.session.activeTurnId;
      if (targetTurnId === null) {
        yield* logConvergence(row, "settlement", "pending", {
          action: "awaiting-target-turn-resolution",
          reason: `active turn '${activeTurnId}' cannot yet be correlated to message '${row.messageId}'`,
        });
        return;
      }
      if (activeTurnId !== targetTurnId) {
        yield* logConvergence(row, "settlement", "pending", {
          action: "active-turn-diverged",
          reason: `active turn '${activeTurnId}' differs from retraction target '${targetTurnId}'; foreign turn will not be interrupted`,
        });
        return;
      }

      if (providerService.validateRollbackConversationTo) {
        yield* providerService
          .validateRollbackConversationTo({
            threadId: row.threadId,
            retainedTurnCount: row.baselineTurnCount,
            targetTurnId,
          })
          .pipe(
            Effect.mapError((error) => ({
              stage: "provider-rollback" as const,
              retryable: !isTerminalProviderError(error),
              detail: failureDetail(error),
              ...(isUnavailableRetainedBoundary(error) ? { silent: true } : {}),
            })),
          );
      }

      const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
      const priorAttempt = readInterruptAttempt(row.requestId, targetTurnId);
      const retryCadenceMillis = Duration.toMillis(interruptRetryCadence);
      const interruptDue =
        priorAttempt === undefined || nowMillis - priorAttempt.issuedAtMillis >= retryCadenceMillis;
      const attempt = interruptDue
        ? markInterruptIssued(row.requestId, row.threadId, targetTurnId, nowMillis)
        : priorAttempt.attempt;
      const interruptAcknowledged = interruptDue
        ? yield* providerService
            .interruptTurn({
              threadId: row.threadId,
              turnId: targetTurnId,
            })
            .pipe(
              Effect.mapError((error) => ({
                stage: "interrupt" as const,
                retryable: !isTerminalProviderError(error),
                detail: failureDetail(error),
              })),
              Effect.tapError(() =>
                Effect.sync(() => clearIssuedInterrupt(row.requestId, targetTurnId)),
              ),
              Effect.timeoutOption(interruptTimeout),
              Effect.map(Option.isSome),
            )
        : undefined;

      // Interrupt acknowledgement is not settlement. A later provider/runtime
      // lifecycle event wakes this row after the projected session leaves
      // starting/running.
      const afterInterrupt = yield* projectionSnapshotQuery.getThreadDetailById(row.threadId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.mapError((error) => ({
          stage: "settlement" as const,
          retryable: true,
          detail: failureDetail(error),
        })),
      );
      if (
        afterInterrupt?.session?.status === "starting" ||
        afterInterrupt?.session?.status === "running"
      ) {
        yield* logConvergence(row, "settlement", "pending", {
          action: !interruptDue
            ? "turn-interrupt-already-requested"
            : attempt > 1
              ? "turn-interrupt-reissued"
              : interruptAcknowledged
                ? "turn-interrupt-acknowledged"
                : "turn-interrupt-timed-out",
          reason: `projected session remains '${afterInterrupt.session.status}' for target turn '${targetTurnId}'`,
          attempt,
        });
        return;
      }
    }

    yield* providerService
      .rollbackConversationTo({
        threadId: row.threadId,
        retainedTurnCount: row.baselineTurnCount,
        ...(targetTurnId !== null ? { targetTurnId } : {}),
      })
      .pipe(
        Effect.mapError((error) => ({
          stage: "provider-rollback" as const,
          retryable: !isTerminalProviderError(error),
          detail: failureDetail(error),
          ...(isUnavailableRetainedBoundary(error) ? { silent: true } : {}),
        })),
      );
    yield* restoreFilesystem(row, false);
    yield* dispatchCompletion(row, targetTurnId);
    clearIssuedInterrupts(row.requestId);
    yield* logConvergence(row, "cleanup", "completed", {
      action: sessionWasActive
        ? "interrupt-settled-provider-rollback-restore-and-complete"
        : "provider-rollback-restore-and-complete",
    });
  });

  const processThread = Effect.fn("processTurnRetractionThread")(function* (threadId: ThreadId) {
    const latest = yield* turnRetractions.getLatestByThreadId({ threadId });
    if (Option.isNone(latest) || latest.value.status !== "requested") return;
    yield* converge(latest.value).pipe(
      Effect.catch((failure) =>
        logConvergence(latest.value, failure.stage, "failed", {
          action: failure.retryable ? "leave-pending-for-retry" : "persist-terminal-failure",
          reason: failure.detail,
        }).pipe(
          Effect.andThen(
            failure.retryable
              ? Effect.logWarning("turn retraction remains pending after retryable failure", {
                  threadId,
                  requestId: latest.value.requestId,
                  stage: failure.stage,
                  detail: failure.detail,
                })
              : appendTerminalFailure(latest.value, failure).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => clearIssuedInterrupts(latest.value.requestId)),
                  ),
                  Effect.catchCause((cause) =>
                    Effect.logWarning("failed to persist terminal turn retraction failure", {
                      threadId,
                      requestId: latest.value.requestId,
                      cause: Cause.pretty(cause),
                    }),
                  ),
                ),
          ),
        ),
      ),
    );
  });

  const processThreadSafely = (threadId: ThreadId) =>
    processThread(threadId).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
        return Effect.logWarning("turn retraction reactor failed to process thread", {
          threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );
  const worker = yield* makeDrainableWorker(processThreadSafely);

  const isDomainTrigger = (event: OrchestrationEvent): boolean =>
    (event.type === "thread.turn-interrupt-requested" && event.payload.retraction !== undefined) ||
    event.type === "thread.session-set" ||
    event.type === "thread.turn-diff-completed";

  const isRuntimeTrigger = (event: ProviderRuntimeEvent): boolean =>
    event.type === "turn.started" ||
    event.type === "turn.completed" ||
    event.type === "turn.aborted" ||
    event.type === "session.started" ||
    event.type === "session.state.changed" ||
    event.type === "session.exited";

  const enqueuePending = Effect.fn("enqueuePendingTurnRetractions")(function* () {
    const pending = yield* turnRetractions.listPending().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("turn retraction pending scan failed", {
          cause: Cause.pretty(cause),
        }).pipe(Effect.as([] as ReadonlyArray<ProjectionTurnRetraction>)),
      ),
    );
    yield* Effect.forEach(pending, (row) => worker.enqueue(row.threadId), {
      concurrency: 1,
      discard: true,
    });
  });

  const enqueueInterruptRetries = Effect.fn("enqueueInterruptRetractions")(function* () {
    const threadIds = new Set(interruptThreadIdsByRequest.values());
    yield* Effect.forEach(threadIds, worker.enqueue, { concurrency: 1, discard: true });
  });

  const start: TurnRetractionReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        isDomainTrigger(event) && "threadId" in event.payload
          ? worker.enqueue(event.payload.threadId)
          : Effect.void,
      ),
    );
    yield* forkParked(
      Stream.runForEach(providerService.streamEvents, (event) =>
        isRuntimeTrigger(event) ? worker.enqueue(event.threadId) : Effect.void,
      ),
    );

    yield* enqueuePending();
    yield* forkParked(Stream.runForEach(retryTicks, enqueuePending));
    yield* forkParked(Stream.runForEach(interruptRetryTicks, enqueueInterruptRetries));
  });

  return {
    start,
    drain: worker.drain,
  } satisfies TurnRetractionReactorShape;
});

export const TurnRetractionReactorLive = Layer.effect(
  TurnRetractionReactor,
  makeTurnRetractionReactor,
).pipe(
  Layer.provide(ProjectionTurnRetractionRepositoryLive),
  Layer.provide(ProjectionTurnRepositoryLive),
);
