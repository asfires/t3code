import {
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationReadModel,
  type OrchestrationSessionStatus,
  type OrchestrationThread,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { ProviderAdapterRequestError, ProviderValidationError } from "../../provider/Errors.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import {
  type ProjectionTurnRetraction,
  ProjectionTurnRetractionRepository,
  type ProjectionTurnRetractionRepositoryShape,
} from "../../persistence/Services/ProjectionTurnRetractions.ts";
import {
  ProjectionTurnRepository,
  type ProjectionTurnRepositoryShape,
} from "../../persistence/Services/ProjectionTurns.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { projectEvent } from "../projector.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { TurnRetractionReactor } from "../Services/TurnRetractionReactor.ts";
import {
  makeTurnRetractionReactor,
  TurnRetractionInterruptTimeout,
  TurnRetractionRetryTicks,
} from "./TurnRetractionReactor.ts";

const NOW = "2026-08-11T12:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-retraction-reactor");
const PROJECT_ID = ProjectId.make("project-retraction-reactor");
const MESSAGE_ID = MessageId.make("message-retracted");
const TURN_ID = TurnId.make("turn-retracted");
const REQUEST_ID = CommandId.make("request-retract");
const BASELINE_REF = CheckpointRef.make(`refs/t3/checkpoints/${THREAD_ID}/1`);

type MutableState = {
  row: ProjectionTurnRetraction;
  sessionStatus: OrchestrationSessionStatus | null;
  historyTurnCount: number;
  rollbackTargetTurnId: TurnId | undefined;
  filesystemRestored: boolean;
  failRollbackAfterEffect: boolean;
  failRestoreAfterEffect: boolean;
  failCompletionAfterCommit: boolean;
  terminalRollbackFailure: boolean;
  interruptAcknowledgementHangs: boolean;
  readonly order: string[];
  readonly dispatched: OrchestrationCommand[];
};

function pendingRow(
  providerSendState: ProjectionTurnRetraction["providerSendState"],
  firstUserMessage = false,
): ProjectionTurnRetraction {
  return {
    requestId: REQUEST_ID,
    threadId: THREAD_ID,
    messageId: MESSAGE_ID,
    baselineTurnCount: 1,
    baselineCheckpointRef: BASELINE_REF,
    targetTurnId: providerSendState === "cancelled" ? null : TURN_ID,
    providerSendClaimed: providerSendState === "claimed",
    providerSendState,
    firstUserMessage,
    requestedAt: NOW,
    status: "requested",
    completedAt: null,
    failedAt: null,
  };
}

function makeState(providerSendState: ProjectionTurnRetraction["providerSendState"]): MutableState {
  return {
    row: pendingRow(providerSendState),
    sessionStatus: providerSendState === "claimed" ? "running" : null,
    historyTurnCount: 2,
    rollbackTargetTurnId: undefined,
    filesystemRestored: false,
    failRollbackAfterEffect: false,
    failRestoreAfterEffect: false,
    failCompletionAfterCommit: false,
    terminalRollbackFailure: false,
    interruptAcknowledgementHangs: false,
    order: [],
    dispatched: [],
  };
}

function projectedThread(state: MutableState): OrchestrationThread {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Retraction reactor",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: "/tmp/retraction-reactor-workspace",
    latestTurn: {
      turnId: TURN_ID,
      state: state.sessionStatus === "running" ? "running" : "interrupted",
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: state.sessionStatus === "running" ? null : NOW,
      assistantMessageId: null,
    },
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    deletedAt: null,
    messages: [
      {
        id: MESSAGE_ID,
        role: "user",
        text: "retract me",
        turnId: null,
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session:
      state.sessionStatus === null
        ? null
        : {
            threadId: THREAD_ID,
            status: state.sessionStatus,
            providerName: "Codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "full-access",
            activeTurnId: state.sessionStatus === "running" ? TURN_ID : null,
            lastError: null,
            updatedAt: NOW,
          },
    turnRetraction: state.row,
  };
}

function makeRepository(state: MutableState): ProjectionTurnRetractionRepositoryShape {
  return {
    upsertPending: (row) => Effect.sync(() => void (state.row = row)),
    markCompleted: ({ completedAt, targetTurnId }) =>
      Effect.sync(() => {
        state.row = { ...state.row, status: "completed", completedAt, targetTurnId };
      }),
    markFailed: ({ failedAt }) =>
      Effect.sync(() => {
        state.row = { ...state.row, status: "failed", failedAt };
      }),
    claimProviderSend: () => Effect.succeed("claimed"),
    cancelPendingProviderSend: () =>
      Effect.sync(() => {
        if (state.row.providerSendState === "unclaimed") {
          state.row = {
            ...state.row,
            providerSendClaimed: false,
            providerSendState: "cancelled",
          };
          return true;
        }
        return state.row.providerSendState === "cancelled";
      }),
    getByRequestId: ({ requestId }) =>
      Effect.succeed(requestId === state.row.requestId ? Option.some(state.row) : Option.none()),
    getLatestByThreadId: ({ threadId }) =>
      Effect.succeed(threadId === state.row.threadId ? Option.some(state.row) : Option.none()),
    listPending: () => Effect.succeed(state.row.status === "requested" ? [state.row] : []),
  };
}

const unsupported = <A>() =>
  Effect.die(new Error("unsupported test operation")) as Effect.Effect<A>;

async function startHarness(state: MutableState) {
  const domainEvents = Effect.runSync(PubSub.unbounded<OrchestrationEvent>());
  const runtimeEvents = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const retryTicks = Effect.runSync(Queue.unbounded<void>());
  const repository = makeRepository(state);
  const dispatch = vi.fn((command: OrchestrationCommand) => {
    state.dispatched.push(command);
    if (command.type === "thread.turn.retract.complete") {
      state.order.push("complete");
      state.row = {
        ...state.row,
        status: "completed",
        completedAt: command.createdAt,
        targetTurnId: command.targetTurnId ?? state.row.targetTurnId,
      };
      if (state.failCompletionAfterCommit) {
        state.failCompletionAfterCommit = false;
        return Effect.die(new Error("simulated crash after completion commit"));
      }
    }
    if (
      command.type === "thread.activity.append" &&
      command.activity.kind === "turn.retract.failed"
    ) {
      state.row = {
        ...state.row,
        status: "failed",
        failedAt: command.activity.createdAt,
      };
    }
    return Effect.succeed({ sequence: state.dispatched.length });
  });
  const engine = OrchestrationEngineService.of({
    readEvents: () => Stream.empty,
    dispatch,
    get streamDomainEvents() {
      return Stream.fromPubSub(domainEvents);
    },
    latestSequence: Effect.succeed(0),
  });
  const query = ProjectionSnapshotQuery.of({
    getThreadDetailById: (threadId: ThreadId) =>
      Effect.succeed(threadId === THREAD_ID ? Option.some(projectedThread(state)) : Option.none()),
    getProjectShellById: (projectId: ProjectId) =>
      Effect.succeed(
        projectId === PROJECT_ID
          ? Option.some({
              id: PROJECT_ID,
              title: "Project",
              workspaceRoot: "/tmp/retraction-reactor-workspace",
              defaultModelSelection: null,
              defaultThreadEnvMode: null,
              faviconPath: null,
              scripts: [],
              createdAt: NOW,
              updatedAt: NOW,
            } as unknown as OrchestrationProjectShell)
          : Option.none(),
      ),
  } as unknown as ProjectionSnapshotQueryShape);
  const turnRepository = ProjectionTurnRepository.of({
    listByThreadId: () =>
      Effect.succeed([
        {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          pendingMessageId: MESSAGE_ID,
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          assistantMessageId: null,
          state: state.sessionStatus === "running" ? "running" : "interrupted",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: state.sessionStatus === "running" ? null : NOW,
          checkpointTurnCount: null,
          checkpointRef: null,
          checkpointStatus: null,
          checkpointFiles: [],
        },
      ]),
  } as unknown as ProjectionTurnRepositoryShape);
  const provider = ProviderService.of({
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () =>
      Effect.sync(() => {
        state.order.push("interrupt");
        if (state.interruptAcknowledgementHangs) {
          // Models Codex emitting turn/completed while its turn/interrupt RPC
          // response remains unresolved.
          state.sessionStatus = "ready";
        }
      }).pipe(Effect.andThen(state.interruptAcknowledgementHangs ? Effect.never : Effect.void)),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions: () => Effect.succeed([]),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    getInstanceInfo: (instanceId) =>
      Effect.succeed({
        instanceId,
        driverKind: ProviderDriverKind.make("codex"),
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind: ProviderDriverKind.make("codex"),
          continuationKey: `codex:instance:${instanceId}`,
        },
      }),
    rollbackConversation: () => unsupported(),
    rollbackConversationTo: ({ retainedTurnCount, targetTurnId }) =>
      Effect.gen(function* () {
        state.order.push("rollback");
        state.rollbackTargetTurnId = targetTurnId;
        if (state.terminalRollbackFailure) {
          return yield* new ProviderValidationError({
            operation: "ProviderService.rollbackConversationTo",
            issue: "provider resume state is unavailable",
          });
        }
        state.historyTurnCount = retainedTurnCount;
        if (state.failRollbackAfterEffect) {
          state.failRollbackAfterEffect = false;
          return yield* new ProviderAdapterRequestError({
            provider: "codex",
            method: "thread/rollback",
            detail: "simulated crash after provider rollback",
          });
        }
      }),
    get streamEvents() {
      return Stream.fromPubSub(runtimeEvents);
    },
  } satisfies ProviderServiceShape);
  const checkpointService = CheckpointStore.CheckpointStore.of({
    isGitRepository: () => Effect.succeed(true),
    captureCheckpoint: () => Effect.void,
    hasCheckpointRef: () => Effect.succeed(true),
    restoreCheckpoint: () =>
      Effect.sync(() => {
        state.order.push("restore");
        state.filesystemRestored = true;
        if (state.failRestoreAfterEffect) {
          state.failRestoreAfterEffect = false;
          throw new Error("simulated crash after filesystem restore");
        }
        return true;
      }),
    diffCheckpoints: () => unsupported(),
    deleteCheckpointRefs: () => Effect.void,
  });
  const workspaceEntries = WorkspaceEntries.WorkspaceEntries.of({
    browse: () => unsupported(),
    list: () => unsupported(),
    search: () => unsupported(),
    searchContents: () => unsupported(),
    refresh: () => Effect.void,
  });

  const layer = Layer.effect(TurnRetractionReactor, makeTurnRetractionReactor).pipe(
    Layer.provideMerge(Layer.succeed(TurnRetractionRetryTicks, Stream.fromQueue(retryTicks))),
    Layer.provideMerge(Layer.succeed(TurnRetractionInterruptTimeout, "1 millis")),
    Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine)),
    Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, query)),
    Layer.provideMerge(Layer.succeed(ProjectionTurnRetractionRepository, repository)),
    Layer.provideMerge(Layer.succeed(ProjectionTurnRepository, turnRepository)),
    Layer.provideMerge(Layer.succeed(ProviderService, provider)),
    Layer.provideMerge(Layer.succeed(CheckpointStore.CheckpointStore, checkpointService)),
    Layer.provideMerge(Layer.succeed(WorkspaceEntries.WorkspaceEntries, workspaceEntries)),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  const reactor = await runtime.runPromise(Effect.service(TurnRetractionReactor));
  const scope = await Effect.runPromise(Scope.make("sequential"));
  await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
  await runtime.runPromise(reactor.drain);
  return {
    reactor,
    runtime,
    scope,
    emitDomain: (event: OrchestrationEvent) =>
      runtime.runPromise(PubSub.publish(domainEvents, event)),
    retryTick: () => runtime.runPromise(Queue.offer(retryTicks, undefined)),
  };
}

async function stopHarness(harness: Awaited<ReturnType<typeof startHarness>>) {
  await Effect.runPromise(Scope.close(harness.scope, Exit.void));
  await harness.runtime.dispose();
}

it("completes a cancelled provider-send path after filesystem convergence", async () => {
  const state = makeState("cancelled");
  const harness = await startHarness(state);
  expect(state.row.status).toBe("completed");
  expect(state.filesystemRestored).toBe(true);
  expect(state.order).toEqual(["restore", "complete"]);
  await stopHarness(harness);
});

it("drives claimed convergence from interrupt through a settlement event", async () => {
  const state = makeState("claimed");
  const harness = await startHarness(state);
  expect(state.order).toEqual(["interrupt"]);
  expect(state.row.status).toBe("requested");

  await harness.retryTick();
  await harness.runtime.runPromise(harness.reactor.drain);
  expect(state.order).toEqual(["interrupt"]);

  state.sessionStatus = "ready";
  await harness.emitDomain({
    sequence: 10,
    eventId: EventId.make("evt-settled"),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    occurredAt: NOW,
    commandId: CommandId.make("cmd-settled"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.session-set",
    payload: {
      threadId: THREAD_ID,
      session: {
        threadId: THREAD_ID,
        status: "ready",
        providerName: "Codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: NOW,
      },
    },
  });
  await harness.runtime.runPromise(Effect.yieldNow);
  await harness.runtime.runPromise(harness.reactor.drain);

  expect(state.order).toEqual(["interrupt", "rollback", "restore", "complete"]);
  expect(state.historyTurnCount).toBe(1);
  expect(state.rollbackTargetTurnId).toBe(TURN_ID);
  expect(state.row.status).toBe("completed");
  await stopHarness(harness);
});

it("converges when settlement is projected but the interrupt acknowledgement hangs", async () => {
  const state = makeState("claimed");
  state.interruptAcknowledgementHangs = true;
  const harness = await startHarness(state);

  expect(state.order).toEqual(["interrupt", "rollback", "restore", "complete"]);
  expect(state.sessionStatus).toBe("ready");
  expect(state.historyTurnCount).toBe(1);
  expect(state.row.status).toBe("completed");
  await stopHarness(harness);
});

it("retries a pending row on the next periodic tick without a lifecycle event", async () => {
  const state = makeState("claimed");
  state.sessionStatus = "ready";
  state.failRollbackAfterEffect = true;
  const harness = await startHarness(state);

  expect(state.row.status).toBe("requested");
  expect(state.historyTurnCount).toBe(1);
  expect(state.order).toEqual(["rollback"]);

  await harness.retryTick();
  await harness.runtime.runPromise(harness.reactor.drain);

  expect(state.row.status).toBe("completed");
  expect(state.historyTurnCount).toBe(1);
  expect(state.order).toEqual(["rollback", "rollback", "restore", "complete"]);
  await stopHarness(harness);
});

it("repeats absolute provider rollback harmlessly after a post-rollback crash", async () => {
  const state = makeState("claimed");
  state.sessionStatus = "ready";
  state.failRollbackAfterEffect = true;
  const harness = await startHarness(state);

  expect(state.row.status).toBe("requested");
  expect(state.historyTurnCount).toBe(1);
  expect(state.order.filter((entry) => entry === "rollback")).toHaveLength(1);

  await harness.retryTick();
  await harness.runtime.runPromise(harness.reactor.drain);

  expect(state.row.status).toBe("completed");
  expect(state.historyTurnCount).toBe(1);
  expect(state.order.filter((entry) => entry === "rollback")).toHaveLength(2);
  expect(state.order.slice(-3)).toEqual(["rollback", "restore", "complete"]);
  await stopHarness(harness);
});

it("resumes after crashes between interrupt, rollback, restore, and completion", async () => {
  const state = makeState("claimed");

  let harness = await startHarness(state);
  expect(state.order).toEqual(["interrupt"]);
  await stopHarness(harness);

  state.sessionStatus = "ready";
  state.failRollbackAfterEffect = true;
  harness = await startHarness(state);
  expect(state.row.status).toBe("requested");
  expect(state.historyTurnCount).toBe(1);
  await stopHarness(harness);

  state.failRestoreAfterEffect = true;
  harness = await startHarness(state);
  expect(state.row.status).toBe("requested");
  expect(state.filesystemRestored).toBe(true);
  await stopHarness(harness);

  state.failCompletionAfterCommit = true;
  harness = await startHarness(state);
  expect(state.row.status).toBe("completed");
  await stopHarness(harness);

  const callsBeforeFinalRestart = [...state.order];
  harness = await startHarness(state);
  expect(state.order).toEqual(callsBeforeFinalRestart);
  await stopHarness(harness);
  expect(state.order).toEqual([
    "interrupt",
    "rollback",
    "rollback",
    "restore",
    "rollback",
    "restore",
    "complete",
  ]);
});

it.effect("ignores late message and checkpoint events for a completed tombstone", () =>
  Effect.gen(function* () {
    const state = makeState("claimed");
    state.row = { ...state.row, status: "completed", completedAt: NOW };
    const model: OrchestrationReadModel = {
      snapshotSequence: 1,
      projects: [],
      threads: [
        {
          ...projectedThread(state),
          latestTurn: null,
          session: null,
          messages: [],
          checkpoints: [],
        },
      ],
      updatedAt: NOW,
    };
    const base = {
      aggregateKind: "thread" as const,
      aggregateId: THREAD_ID,
      occurredAt: NOW,
      commandId: CommandId.make("cmd-late"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
    };
    const afterMessage = yield* projectEvent(model, {
      ...base,
      sequence: 2,
      eventId: EventId.make("evt-late-message"),
      type: "thread.message-sent",
      payload: {
        threadId: THREAD_ID,
        messageId: MessageId.make("late-assistant"),
        role: "assistant",
        text: "late",
        turnId: TURN_ID,
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    });
    const afterCheckpoint = yield* projectEvent(afterMessage, {
      ...base,
      sequence: 3,
      eventId: EventId.make("evt-late-checkpoint"),
      type: "thread.turn-diff-completed",
      payload: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        checkpointTurnCount: 2,
        checkpointRef: CheckpointRef.make("late-ref"),
        status: "ready",
        files: [],
        assistantMessageId: MessageId.make("late-assistant"),
        completedAt: NOW,
      },
    });
    expect(afterCheckpoint.threads[0]?.messages).toEqual([]);
    expect(afterCheckpoint.threads[0]?.checkpoints).toEqual([]);
    expect(afterCheckpoint.threads[0]?.latestTurn).toBeNull();
  }),
);

it("marks terminal provider rollback failure with the correlated activity shape", async () => {
  const state = makeState("claimed");
  state.sessionStatus = "ready";
  state.terminalRollbackFailure = true;
  const harness = await startHarness(state);
  expect(state.row.status).toBe("failed");
  const failure = state.dispatched.find(
    (command) =>
      command.type === "thread.activity.append" && command.activity.kind === "turn.retract.failed",
  );
  expect(failure).toMatchObject({
    type: "thread.activity.append",
    activity: {
      tone: "error",
      kind: "turn.retract.failed",
      summary: "Message retract failed",
      payload: {
        requestId: REQUEST_ID,
        messageId: MESSAGE_ID,
        stage: "provider-rollback",
        retryable: false,
      },
    },
  });
  await stopHarness(harness);
});

it.layer(NodeServices.layer)("first-message completion integration", (it) => {
  it.effect("produces reverted and deleted atomically through the WO4a decider", () =>
    Effect.gen(function* () {
      const state = makeState("cancelled");
      state.row = pendingRow("cancelled", true);
      const thread = {
        ...projectedThread(state),
        managedWorktree: {
          projectCwd: "/tmp/project",
          path: "/tmp/project-worktree",
          createdForCommandId: CommandId.make("cmd-first-send"),
        },
        turnRetraction: state.row,
      };
      const decided = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.retract.complete",
          commandId: CommandId.make("cmd-complete-first-message"),
          threadId: THREAD_ID,
          requestId: REQUEST_ID,
          createdAt: NOW,
        },
        readModel: {
          snapshotSequence: 0,
          projects: [],
          threads: [thread],
          updatedAt: NOW,
        },
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual(["thread.reverted", "thread.deleted"]);
    }),
  );
});
