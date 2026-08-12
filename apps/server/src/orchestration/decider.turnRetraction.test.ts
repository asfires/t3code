import {
  CheckpointRef,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:01.000Z";
const MESSAGE_AT = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-retract");
const MESSAGE_ID = MessageId.make("message-latest");
const TURN_ID = TurnId.make("turn-current");

function makeMessage(
  id: MessageId,
  role: "user" | "assistant",
  text: string,
  turnId: TurnId | null = null,
  createdAt = MESSAGE_AT,
): OrchestrationThread["messages"][number] {
  return { id, role, text, turnId, streaming: false, createdAt, updatedAt: createdAt };
}

function makeThread(patch: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: THREAD_ID,
    projectId: ProjectId.make("project-1"),
    title: "Retract",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: MESSAGE_AT,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [makeMessage(MESSAGE_ID, "user", "undo this")],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...patch,
  };
}

function runningThread(patch: Partial<OrchestrationThread> = {}) {
  return makeThread({
    latestTurn: {
      turnId: TURN_ID,
      state: "running",
      requestedAt: MESSAGE_AT,
      startedAt: MESSAGE_AT,
      completedAt: null,
      assistantMessageId: null,
    },
    session: {
      threadId: THREAD_ID,
      status: "running",
      providerName: "Codex",
      runtimeMode: "full-access",
      activeTurnId: TURN_ID,
      lastError: null,
      updatedAt: MESSAGE_AT,
    },
    ...patch,
  });
}

function readModel(thread: OrchestrationThread): OrchestrationReadModel {
  return { snapshotSequence: 0, projects: [], threads: [thread], updatedAt: NOW };
}

function retract(thread: OrchestrationThread, commandId = "cmd-retract") {
  return decideOrchestrationCommand({
    command: {
      type: "thread.turn.retract",
      commandId: CommandId.make(commandId),
      threadId: THREAD_ID,
      messageId: MESSAGE_ID,
      createdAt: NOW,
    },
    readModel: readModel(thread),
  });
}

function pendingRetraction(firstUserMessage: boolean): OrchestrationThread {
  return makeThread({
    managedWorktree: {
      projectCwd: "/tmp/project",
      path: "/tmp/project-worktree",
      createdForCommandId: CommandId.make("cmd-first-send"),
    },
    turnRetraction: {
      requestId: CommandId.make("cmd-retract-request"),
      messageId: MESSAGE_ID,
      baselineTurnCount: firstUserMessage ? 0 : 2,
      baselineCheckpointRef: CheckpointRef.make(
        firstUserMessage
          ? `refs/t3/checkpoints/${THREAD_ID}/0`
          : `refs/t3/checkpoints/${THREAD_ID}/2`,
      ),
      targetTurnId: TURN_ID,
      providerSendClaimed: true,
      firstUserMessage,
      requestedAt: MESSAGE_AT,
      status: "requested",
      completedAt: null,
      failedAt: null,
    },
  });
}

function completeRetraction(thread: OrchestrationThread) {
  return decideOrchestrationCommand({
    command: {
      type: "thread.turn.retract.complete",
      commandId: CommandId.make("cmd-retract-complete"),
      threadId: THREAD_ID,
      requestId: CommandId.make("cmd-retract-request"),
      createdAt: NOW,
    },
    readModel: readModel(thread),
  });
}

function firstEvent(
  result:
    | Omit<OrchestrationEvent, "sequence">
    | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
) {
  return Array.isArray(result) ? result[0] : (result as Omit<OrchestrationEvent, "sequence">);
}

function invariantDetail(error: unknown): string {
  expect(error).toHaveProperty("detail");
  return (error as { readonly detail: string }).detail;
}

it.layer(NodeServices.layer)("thread.turn.retract decider", (it) => {
  it.effect("blocks new turn starts while a retraction remains requested", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-start-while-retracting"),
          threadId: THREAD_ID,
          message: {
            messageId: MessageId.make("message-too-soon"),
            role: "user",
            text: "too soon",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel: readModel(pendingRetraction(false)),
      }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(invariantDetail(result.failure)).toContain("pending retraction");
      }
    }),
  );

  it.effect("atomically emits reverted and deleted for first-message completion", () =>
    Effect.gen(function* () {
      const decided = yield* completeRetraction(pendingRetraction(true));
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual(["thread.reverted", "thread.deleted"]);
      expect(events[0]).toMatchObject({
        commandId: CommandId.make("cmd-retract-complete"),
        type: "thread.reverted",
        payload: {
          threadId: THREAD_ID,
          turnCount: 0,
          retraction: {
            requestId: CommandId.make("cmd-retract-request"),
            messageId: MESSAGE_ID,
            turnId: TURN_ID,
            firstUserMessage: true,
            completedAt: NOW,
          },
        },
      });
      expect(events[1]).toMatchObject({
        commandId: CommandId.make("cmd-retract-complete"),
        type: "thread.deleted",
        payload: {
          threadId: THREAD_ID,
          deletedAt: NOW,
          retraction: {
            requestId: CommandId.make("cmd-retract-request"),
            messageId: MESSAGE_ID,
            firstUserMessage: true,
            managedWorktreeCreatedForCommandId: CommandId.make("cmd-first-send"),
          },
        },
      });
    }),
  );

  it.effect("emits only reverted for later-message completion", () =>
    Effect.gen(function* () {
      const decided = yield* completeRetraction(pendingRetraction(false));
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((event) => event.type)).toEqual(["thread.reverted"]);
      expect(events[0]).toMatchObject({
        payload: {
          turnCount: 2,
          retraction: { firstUserMessage: false },
        },
      });
    }),
  );

  it.effect("rejects a duplicate completion after the first commit completed the row", () =>
    Effect.gen(function* () {
      const pending = pendingRetraction(false);
      const completed = makeThread({
        ...pending,
        turnRetraction: pending.turnRetraction
          ? {
              ...pending.turnRetraction,
              status: "completed",
              completedAt: NOW,
            }
          : null,
      });

      const error = yield* Effect.flip(completeRetraction(completed));
      expect(invariantDetail(error)).toContain("no matching pending retraction");
    }),
  );

  it.effect("accepts queued, starting, and matching running lifecycle states", () =>
    Effect.gen(function* () {
      const queued = makeThread();
      const starting = makeThread({
        session: {
          threadId: THREAD_ID,
          status: "starting",
          providerName: "Claude",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        },
      });

      for (const [index, thread] of [queued, starting, runningThread()].entries()) {
        const event = firstEvent(yield* retract(thread, `cmd-accept-${index}`));
        if (event?.type !== "thread.turn-interrupt-requested") continue;
        expect(event.payload.retraction).toMatchObject({
          requestId: CommandId.make(`cmd-accept-${index}`),
          messageId: MESSAGE_ID,
          baselineTurnCount: 0,
          firstUserMessage: true,
        });
        expect(event.payload.retraction?.targetTurnId).toBe(index === 2 ? TURN_ID : null);
      }
    }),
  );

  it.effect("keeps thinking-only and empty assistant state retractable", () =>
    Effect.gen(function* () {
      const thread = runningThread({
        messages: [
          makeMessage(MESSAGE_ID, "user", "undo this"),
          makeMessage(MessageId.make("assistant-empty"), "assistant", "", TURN_ID),
        ],
        activities: [
          {
            id: EventId.make("activity-thinking"),
            tone: "info",
            kind: "task.progress",
            summary: "Reasoning update",
            payload: {},
            turnId: TURN_ID,
            createdAt: NOW,
          },
        ],
      });
      expect(firstEvent(yield* retract(thread))?.type).toBe("thread.turn-interrupt-requested");
    }),
  );

  it.effect("rejects every assistant-visible output form", () =>
    Effect.gen(function* () {
      const variants: OrchestrationThread[] = [
        runningThread({
          messages: [
            makeMessage(MESSAGE_ID, "user", "undo this"),
            makeMessage(MessageId.make("assistant-text"), "assistant", "hello", TURN_ID),
          ],
        }),
        runningThread({
          activities: [
            {
              id: EventId.make("activity-tool"),
              tone: "tool",
              kind: "tool.started",
              summary: "Running command",
              payload: {},
              turnId: TURN_ID,
              createdAt: NOW,
            },
          ],
        }),
        runningThread({
          activities: [
            {
              id: EventId.make("activity-plan"),
              tone: "info",
              kind: "turn.plan.updated",
              summary: "Plan updated",
              payload: { plan: [] },
              turnId: TURN_ID,
              createdAt: NOW,
            },
          ],
        }),
        runningThread({
          proposedPlans: [
            {
              id: "plan-1",
              turnId: TURN_ID,
              planMarkdown: "# Plan",
              implementedAt: null,
              implementationThreadId: null,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        }),
      ];

      for (const [index, thread] of variants.entries()) {
        const error = yield* Effect.flip(retract(thread, `cmd-output-${index}`));
        expect(invariantDetail(error)).toContain("assistant-visible output");
      }
    }),
  );

  it.effect("rejects idle, mismatched running, stale-message, and duplicate-pending requests", () =>
    Effect.gen(function* () {
      const idleError = yield* Effect.flip(
        retract(
          makeThread({
            latestTurn: {
              turnId: TurnId.make("turn-old"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: null,
            },
          }),
        ),
      );
      expect(invariantDetail(idleError)).toContain("no queued, starting, or matching running turn");

      const mismatch = runningThread({
        latestTurn: {
          turnId: TurnId.make("turn-other"),
          state: "running",
          requestedAt: MESSAGE_AT,
          startedAt: MESSAGE_AT,
          completedAt: null,
          assistantMessageId: null,
        },
      });
      expect(invariantDetail(yield* Effect.flip(retract(mismatch)))).toContain("no queued");

      const stale = runningThread({
        messages: [
          makeMessage(MESSAGE_ID, "user", "old", null, "2025-12-31T23:59:59.000Z"),
          makeMessage(MessageId.make("message-new"), "user", "new", null, MESSAGE_AT),
        ],
      });
      expect(invariantDetail(yield* Effect.flip(retract(stale)))).toContain(
        "not the newest user message",
      );

      const pending = runningThread({
        turnRetraction: {
          requestId: CommandId.make("cmd-existing"),
          messageId: MESSAGE_ID,
          baselineTurnCount: 0,
          baselineCheckpointRef: CheckpointRef.make("refs/t3/checkpoints/thread/turn/0"),
          targetTurnId: TURN_ID,
          providerSendClaimed: false,
          firstUserMessage: true,
          requestedAt: NOW,
          status: "requested",
          completedAt: null,
          failedAt: null,
        },
      });
      expect(invariantDetail(yield* Effect.flip(retract(pending, "cmd-different")))).toContain(
        "already has pending retraction",
      );
    }),
  );

  it.effect("records the absolute baseline turn count in accepted intent", () =>
    Effect.gen(function* () {
      const thread = runningThread({
        messages: [
          makeMessage(
            MessageId.make("message-first"),
            "user",
            "first",
            null,
            "2025-12-30T00:00:00.000Z",
          ),
          makeMessage(MESSAGE_ID, "user", "undo this"),
        ],
        checkpoints: [
          {
            turnId: TurnId.make("turn-1"),
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("ref-1"),
            status: "ready",
            files: [],
            assistantMessageId: null,
            completedAt: "2025-12-30T00:01:00.000Z",
          },
          {
            turnId: TurnId.make("turn-2"),
            checkpointTurnCount: 2,
            checkpointRef: CheckpointRef.make("ref-2"),
            status: "ready",
            files: [],
            assistantMessageId: null,
            completedAt: "2025-12-31T00:01:00.000Z",
          },
        ],
      });
      const event = firstEvent(yield* retract(thread));
      if (event?.type !== "thread.turn-interrupt-requested") return;
      expect(event.payload.retraction).toMatchObject({
        baselineTurnCount: 2,
        firstUserMessage: false,
      });
    }),
  );
});
