import type { OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThread,
} from "../../persistence/Services/ProjectionThreads.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "../Services/ThreadDeletionReactor.ts";
import { forkParked } from "../../serverActivation.ts";

type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;

export function managedWorktreeCleanupTarget(input: {
  readonly event: ThreadDeletedEvent;
  readonly thread: ProjectionThread;
  readonly hasOtherLiveReference: boolean;
}): ProjectionThread["managedWorktree"] {
  const { event, thread } = input;
  const managedWorktree = thread.managedWorktree;
  if (
    event.payload.retraction === undefined ||
    managedWorktree === null ||
    event.payload.retraction.managedWorktreeCreatedForCommandId !==
      managedWorktree.createdForCommandId ||
    thread.worktreePath !== managedWorktree.path ||
    input.hasOtherLiveReference
  ) {
    return null;
  }
  return managedWorktree;
}

export const logCleanupCauseUnlessInterrupted = <R, E>({
  effect,
  message,
  threadId,
}: {
  readonly effect: Effect.Effect<void, E, R>;
  readonly message: string;
  readonly threadId: ThreadDeletedEvent["payload"]["threadId"];
}): Effect.Effect<void, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logDebug(message, {
        threadId,
        cause: Cause.pretty(cause),
      });
    }),
  );

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const projectionThreadRepository = yield* ProjectionThreadRepository;
  const gitWorkflow = yield* GitWorkflowService;

  const stopProviderSession = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: providerService.stopSession({ threadId }),
      message: "thread deletion cleanup skipped provider session stop",
      threadId,
    });

  const closeThreadTerminals = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: terminalManager.close({ threadId, deleteHistory: true }),
      message: "thread deletion cleanup skipped terminal close",
      threadId,
    });

  const removeRetractedManagedWorktree = Effect.fn("removeRetractedManagedWorktree")(function* (
    event: ThreadDeletedEvent,
  ) {
    if (event.payload.retraction === undefined) return;
    const thread = yield* projectionThreadRepository.getById({
      threadId: event.payload.threadId,
    });
    if (Option.isNone(thread) || thread.value.managedWorktree === null) return;
    const hasOtherLiveReference = yield* projectionThreadRepository.hasOtherLiveWorktreeReference({
      threadId: event.payload.threadId,
      worktreePath: thread.value.managedWorktree.path,
    });
    const target = managedWorktreeCleanupTarget({
      event,
      thread: thread.value,
      hasOtherLiveReference,
    });
    if (target === null) return;
    yield* logCleanupCauseUnlessInterrupted({
      effect: gitWorkflow.removeWorktree({ cwd: target.projectCwd, path: target.path }),
      message: "thread retraction cleanup skipped managed worktree removal",
      threadId: event.payload.threadId,
    });
  });

  const processThreadDeleted = Effect.fn("processThreadDeleted")(function* (
    event: ThreadDeletedEvent,
  ) {
    const { threadId } = event.payload;
    yield* stopProviderSession(threadId);
    yield* closeThreadTerminals(threadId);
    yield* removeRetractedManagedWorktree(event);
  });

  const processThreadDeletedSafely = (event: ThreadDeletedEvent) =>
    processThreadDeleted(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread deletion reactor failed to process event", {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processThreadDeletedSafely);

  const start: ThreadDeletionReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.deleted") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ThreadDeletionReactorShape;
});

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make);
