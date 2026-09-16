import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import * as Option from "effect/Option";
import {
  CommandId,
  CorrelationId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import type { ProjectionThread } from "../../persistence/Services/ProjectionThreads.ts";
import {
  logCleanupCauseUnlessInterrupted,
  managedWorktreeCleanupTarget,
  shouldDiscardTransientProviderThread,
} from "./ThreadDeletionReactor.ts";

const threadId = ThreadId.make("thread-deletion-reactor-test");
const firstSendCommandId = CommandId.make("cmd-first-send");
const managedWorktree = {
  projectCwd: "/tmp/project",
  path: "/tmp/project-worktree",
  createdForCommandId: firstSendCommandId,
} as const;

function deletedEvent(retraction = true) {
  return {
    sequence: 1,
    eventId: EventId.make("event-thread-deleted"),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.deleted",
    occurredAt: "2026-01-01T00:00:00.000Z",
    commandId: CommandId.make("cmd-retract-complete"),
    causationEventId: null,
    correlationId: CommandId.make("cmd-retract-complete"),
    metadata: {},
    payload: {
      threadId,
      deletedAt: "2026-01-01T00:00:00.000Z",
      ...(retraction
        ? {
            retraction: {
              requestId: CommandId.make("cmd-retract"),
              messageId: MessageId.make("message-first"),
              firstUserMessage: true as const,
              managedWorktreeCreatedForCommandId: firstSendCommandId,
            },
          }
        : {}),
    },
  } satisfies Extract<OrchestrationEvent, { type: "thread.deleted" }>;
}

function projectedThread(patch: Partial<ProjectionThread> = {}): ProjectionThread {
  return {
    threadId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature/thread",
    worktreePath: managedWorktree.path,
    managedWorktree,
    latestTurnId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    titleRegenerationRequestId: null,
    titleRegenerationStartedAt: null,
    latestUserMessageAt: null,
    pendingApprovalCount: 0,
    pendingUserInputCount: 0,
    hasActionableProposedPlan: 0,
    deletedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import { ThreadDeletionReactorLive } from "./ThreadDeletionReactor.ts";

describe("logCleanupCauseUnlessInterrupted", () => {
  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});

describe("managedWorktreeCleanupTarget", () => {
  it("selects only an exclusively referenced worktree owned by the retracted first send", () => {
    expect(
      managedWorktreeCleanupTarget({
        event: deletedEvent(),
        thread: projectedThread(),
        hasOtherLiveReference: false,
      }),
    ).toEqual(managedWorktree);
  });

  it("rejects regular deletion, pre-existing, mismatched, and shared worktrees", () => {
    const cases = [
      { event: deletedEvent(false), thread: projectedThread(), hasOtherLiveReference: false },
      {
        event: deletedEvent(),
        thread: projectedThread({ managedWorktree: null }),
        hasOtherLiveReference: false,
      },
      {
        event: deletedEvent(),
        thread: projectedThread({ worktreePath: "/tmp/other-worktree" }),
        hasOtherLiveReference: false,
      },
      { event: deletedEvent(), thread: projectedThread(), hasOtherLiveReference: true },
    ];
    for (const input of cases) {
      expect(managedWorktreeCleanupTarget(input)).toBeNull();
    }

    const mismatch = deletedEvent();
    if (mismatch.payload.retraction !== undefined) {
      mismatch.payload.retraction.managedWorktreeCreatedForCommandId =
        CommandId.make("cmd-other-send");
    }
    expect(
      managedWorktreeCleanupTarget({
        event: mismatch,
        thread: projectedThread(),
        hasOtherLiveReference: false,
      }),
    ).toBeNull();
  });
});

describe("shouldDiscardTransientProviderThread", () => {
  it("selects only durable first-message retraction deletions", () => {
    expect(shouldDiscardTransientProviderThread(deletedEvent())).toBe(true);
    expect(shouldDiscardTransientProviderThread(deletedEvent(false))).toBe(false);
  });
});

describe("ThreadDeletionReactor retraction cleanup", () => {
  effectIt.effect("removes the retracted draft's worktree and then the branch it minted", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const branchDeleted = yield* Deferred.make<void>();
      const engine = {
        latestSequence: Effect.succeed(1),
        streamDomainEvents: Stream.make(deletedEvent()),
      } as unknown as OrchestrationEngineShape;
      const providerService = {
        stopSession: () => Effect.void,
        discardTransientThread: () => Effect.void,
      } as unknown as ProviderServiceShape;
      const terminalManager = {
        close: () => Effect.void,
      } as unknown as TerminalManager.TerminalManager["Service"];
      const layer = ThreadDeletionReactorLive.pipe(
        Layer.provide(
          Layer.mock(GitWorkflowService, {
            removeWorktree: (input) =>
              Effect.sync(() => {
                calls.push(`remove:${input.path}`);
              }),
            deleteBranch: (input) =>
              Effect.sync(() => {
                calls.push(`branch:${input.branch}`);
                return true;
              }).pipe(Effect.tap(() => Deferred.succeed(branchDeleted, undefined))),
          }),
        ),
        Layer.provide(
          Layer.mock(ProjectionThreadRepository, {
            getById: () => Effect.succeed(Option.some(projectedThread())),
            hasOtherLiveWorktreeReference: () => Effect.succeed(false),
          }),
        ),
        Layer.provide(Layer.succeed(ProviderService, providerService)),
        Layer.provide(Layer.succeed(TerminalManager.TerminalManager, terminalManager)),
        Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const reactor = yield* ThreadDeletionReactor;
          yield* reactor.start();
          yield* Deferred.await(branchDeleted);
          expect(calls).toEqual(["remove:/tmp/project-worktree", "branch:feature/thread"]);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );
});

describe("ThreadDeletionReactor drain", () => {
  const now = "2026-01-01T00:00:00.000Z";
  const threadId = ThreadId.make("thread-deletion-reactor-drain");
  const deletedEvent = (sequence: number): OrchestrationEvent => ({
    sequence,
    eventId: EventId.make(`evt-deleted-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.deleted",
    occurredAt: now,
    commandId: CommandId.make(`cmd-deleted-${sequence}`),
    causationEventId: null,
    correlationId: CorrelationId.make(`cmd-deleted-${sequence}`),
    metadata: {},
    payload: { threadId, deletedAt: now },
  });

  effectIt.effect("waits for a published deletion the subscriber has not consumed yet", () =>
    Effect.gen(function* () {
      const stops: Array<number> = [];
      const firstCleanupDone = yield* Deferred.make<void>();
      // The engine has already committed and published sequence 2, but the
      // subscriber has not received it yet: the stream releases it on demand.
      const releaseSecondEvent = yield* Deferred.make<void>();
      const latestSequence = yield* Ref.make(0);
      const engine = {
        latestSequence: Ref.get(latestSequence),
        streamDomainEvents: Stream.concat(
          Stream.make(deletedEvent(1)),
          Stream.fromEffect(Deferred.await(releaseSecondEvent)).pipe(
            Stream.map(() => deletedEvent(2)),
          ),
        ),
      } as unknown as OrchestrationEngineShape;
      const providerService = {
        stopSession: () =>
          Effect.gen(function* () {
            stops.push(stops.length + 1);
            if (stops.length === 1) {
              yield* Deferred.succeed(firstCleanupDone, undefined);
            }
          }),
      } as unknown as ProviderServiceShape;
      const terminalManager = {
        close: () => Effect.void,
      } as unknown as TerminalManager.TerminalManager["Service"];
      const layer = ThreadDeletionReactorLive.pipe(
        Layer.provide(Layer.mock(GitWorkflowService, {})),
        Layer.provide(
          Layer.mock(ProjectionThreadRepository, { getById: () => Effect.succeed(Option.none()) }),
        ),
        Layer.provide(Layer.succeed(ProviderService, providerService)),
        Layer.provide(Layer.succeed(TerminalManager.TerminalManager, terminalManager)),
        Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const reactor = yield* ThreadDeletionReactor;
          yield* reactor.start();
          yield* Deferred.await(firstCleanupDone);

          // Sequence 1 is fully cleaned and the worker queue is idle. Sequence
          // 2 is committed and published but still in flight to the subscriber.
          yield* Ref.set(latestSequence, 2);
          const drained = yield* Effect.forkChild(reactor.drainThrough(2));
          yield* Effect.yieldNow;
          yield* Effect.yieldNow;
          expect(stops).toEqual([1]);
          expect(drained.pollUnsafe()).toBeUndefined();

          yield* Deferred.succeed(releaseSecondEvent, undefined);
          yield* Fiber.join(drained);
          expect(stops).toEqual([1, 2]);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );
});
