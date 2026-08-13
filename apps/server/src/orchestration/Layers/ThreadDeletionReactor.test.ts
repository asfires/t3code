import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
