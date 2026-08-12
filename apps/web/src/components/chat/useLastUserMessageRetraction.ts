import type {
  CommandId,
  MessageId,
  ProviderInteractionMode,
  RuntimeMode,
  ScopedProjectRef,
  ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useEffect, useRef, type RefObject } from "react";

import type { ComposerHandleRef } from "../../composerHandleContext";
import type { ComposerImageAttachment, DraftThreadEnvMode } from "../../composerDraftStore";
import { newCommandId, newDraftId, newThreadId } from "../../lib/utils";
import { threadEnvironment } from "../../state/threads";
import type { Thread } from "../../types";
import { useAtomCommand } from "../../state/use-atom-command";
import { collapseExpandedComposerCursor } from "../../composer-logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { LastUserMessagePopCandidate } from "./lastUserMessagePop";
import {
  captureLastUserMessageImages,
  deriveLastUserMessageRestoredText,
} from "./lastUserMessagePop";
import {
  buildRetractionCommandInput,
  appendImagesToOptimisticRetractionRecovery,
  applyOptimisticRetractionRecoveryToThread,
  discardRetractionRecovery,
  findCorrelatedRetractionFailureInfo,
  handoffCompletedMidThreadRetraction,
  type PendingRetractionRecovery,
  restoreRetractionRecoveryToThread,
  restoreOptimisticRetractionComposer,
  rememberOptimisticRetractionComposer,
  snapshotLastUserMessageRecovery,
  surfaceRetractionRecoveryDraft,
  useRetractionRecoveryStore,
} from "./lastUserMessageRecovery";
import { beginOptimisticRetraction } from "./optimisticRetraction";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

export function useLastUserMessageRetraction(input: {
  activeThread: Thread | undefined;
  activeProjectRef: ScopedProjectRef | null;
  activeThreadBranch: string | null;
  activeEnvironmentUnavailable: boolean;
  candidate: LastUserMessagePopCandidate | null;
  isFirstUserMessage: boolean;
  optimisticBundle?: {
    prompt: string;
    images: ComposerImageAttachment[];
  };
  pendingRecovery: PendingRetractionRecovery | null;
  retractionPending: boolean;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  envMode: DraftThreadEnvMode;
  startFromOrigin: boolean;
  composerRef: ComposerHandleRef;
  promptRef: RefObject<string>;
  composerImagesRef: RefObject<ComposerImageAttachment[]>;
  onOptimisticRetractionStarted: (input: { requestId: CommandId; messageId: MessageId }) => void;
  onOptimisticRetractionFailed: (input: { requestId: CommandId; messageId: MessageId }) => void;
  navigateToRecoveryDraft: (draftId: PendingRetractionRecovery["draftId"]) => void;
  setThreadError: (threadId: ThreadId | null, detail: string | null) => void;
}) {
  const {
    activeThread,
    activeProjectRef,
    activeThreadBranch,
    activeEnvironmentUnavailable,
    candidate,
    isFirstUserMessage,
    optimisticBundle,
    pendingRecovery,
    retractionPending,
    runtimeMode,
    interactionMode,
    envMode,
    startFromOrigin,
    composerRef,
    promptRef,
    composerImagesRef,
    onOptimisticRetractionStarted,
    onOptimisticRetractionFailed,
    navigateToRecoveryDraft,
    setThreadError,
  } = input;
  const retractThreadTurn = useAtomCommand(threadEnvironment.retractTurn, {
    reportFailure: false,
  });
  const applyRestoredComposer = useCallback(
    (restored: NonNullable<ReturnType<typeof restoreRetractionRecoveryToThread>>) => {
      promptRef.current = restored.prompt;
      composerImagesRef.current = restored.images;
      composerRef.current?.resetCursorState({
        cursor: collapseExpandedComposerCursor(restored.prompt, restored.prompt.length),
        prompt: restored.prompt,
        detectTrigger: true,
      });
      window.requestAnimationFrame(() => composerRef.current?.focusAtEnd());
      if (restored.unrestoredImageNames.length > 0) {
        toastManager.add({
          type: "warning",
          title: "Some images could not be restored",
          description: `${restored.unrestoredImageNames.join(", ")} could not be restored to the composer.`,
        });
      }
    },
    [composerImagesRef, composerRef, promptRef],
  );

  const failPendingRetraction = useCallback(
    (recovery: PendingRetractionRecovery, detail: string) => {
      const restored =
        recovery.optimisticDestination === "thread"
          ? (discardRetractionRecovery({ requestId: recovery.requestId }), null)
          : restoreRetractionRecoveryToThread({
              requestId: recovery.requestId,
              sourceThreadRef: recovery.sourceThreadRef,
            });
      if (restored) applyRestoredComposer(restored);
      onOptimisticRetractionFailed({
        requestId: recovery.requestId,
        messageId: recovery.messageId,
      });
      setThreadError(recovery.sourceThreadRef.threadId, detail);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Message restored, but the turn could not be retracted",
          description: detail,
        }),
      );
    },
    [applyRestoredComposer, onOptimisticRetractionFailed, setThreadError],
  );

  const ignorePendingRetraction = useCallback(
    (recovery: PendingRetractionRecovery) => {
      const restored = restoreOptimisticRetractionComposer(recovery.requestId);
      discardRetractionRecovery({ requestId: recovery.requestId });
      if (restored) applyRestoredComposer(restored);
      onOptimisticRetractionFailed({
        requestId: recovery.requestId,
        messageId: recovery.messageId,
      });
    },
    [applyRestoredComposer, onOptimisticRetractionFailed],
  );

  const dispatchesRef = useRef(new Set<string>());
  const recoveryPreparationRef = useRef(false);
  const dispatchPendingRetraction = useCallback(
    async (recovery: PendingRetractionRecovery) => {
      if (dispatchesRef.current.has(recovery.requestId)) return;
      dispatchesRef.current.add(recovery.requestId);
      const result = await retractThreadTurn({
        environmentId: recovery.sourceThreadRef.environmentId,
        input: buildRetractionCommandInput(recovery),
      });
      dispatchesRef.current.delete(recovery.requestId);
      if (result._tag !== "Failure") {
        if (recovery.firstUserMessage ?? isFirstUserMessage) {
          useRetractionRecoveryStore
            .getState()
            .setOptimisticDestination(recovery.requestId, "draft");
          surfaceRetractionRecoveryDraft({
            requestId: recovery.requestId,
            sourceThreadRef: recovery.sourceThreadRef,
            retainRecovery: true,
            navigate: ({ params }) => navigateToRecoveryDraft(params.draftId),
          });
        }
        return;
      }
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      if (
        typeof error === "object" &&
        error !== null &&
        "_tag" in error &&
        error._tag === "EnvironmentRpcUnavailableError"
      ) {
        return;
      }
      failPendingRetraction(recovery, errorMessage(error));
    },
    [failPendingRetraction, isFirstUserMessage, navigateToRecoveryDraft, retractThreadTurn],
  );

  useEffect(() => {
    if (!pendingRecovery || activeEnvironmentUnavailable) return;
    if (activeThread?.turnRetraction?.requestId === pendingRecovery.requestId) return;
    void dispatchPendingRetraction(pendingRecovery);
  }, [
    activeEnvironmentUnavailable,
    activeThread?.turnRetraction,
    dispatchPendingRetraction,
    pendingRecovery,
  ]);

  useEffect(() => {
    if (!pendingRecovery || !activeThread) return;
    const retraction = activeThread.turnRetraction;
    if (
      retraction?.status !== "completed" ||
      retraction.requestId !== pendingRecovery.requestId ||
      retraction.completedAt === null ||
      retraction.firstUserMessage
    ) {
      return;
    }
    const restored = handoffCompletedMidThreadRetraction({
      environmentId: activeThread.environmentId,
      completion: {
        threadId: activeThread.id,
        retraction: {
          requestId: retraction.requestId,
          messageId: retraction.messageId,
          turnId: retraction.targetTurnId,
          firstUserMessage: false,
          completedAt: retraction.completedAt,
        },
      },
    });
    if (restored) applyRestoredComposer(restored);
  }, [activeThread, applyRestoredComposer, pendingRecovery]);

  useEffect(() => {
    if (!pendingRecovery || !activeThread) return;
    const activityFailure = findCorrelatedRetractionFailureInfo(
      activeThread.activities,
      pendingRecovery.requestId,
    );
    const projectedFailure =
      activeThread.turnRetraction?.status === "failed" &&
      activeThread.turnRetraction.requestId === pendingRecovery.requestId;
    if (!projectedFailure && activityFailure === null) return;
    if (activityFailure?.silent) {
      ignorePendingRetraction(pendingRecovery);
      return;
    }
    failPendingRetraction(
      pendingRecovery,
      activityFailure?.detail ?? "The server could not retract this message.",
    );
  }, [activeThread, failPendingRetraction, ignorePendingRetraction, pendingRecovery]);

  return useCallback(async () => {
    if (
      !candidate ||
      !activeThread ||
      !activeProjectRef ||
      retractionPending ||
      recoveryPreparationRef.current
    ) {
      return;
    }
    recoveryPreparationRef.current = true;

    const requestId = newCommandId();
    const createdAt = new Date().toISOString();
    const sourceThreadRef = scopeThreadRef(activeThread.environmentId, activeThread.id);
    const prompt =
      optimisticBundle?.prompt ?? deriveLastUserMessageRestoredText(candidate.message.text);
    const images = optimisticBundle?.images ?? [];
    const bundle = {
      prompt,
      images,
      modelSelection: activeThread.modelSelection,
      runtimeMode,
      interactionMode,
      envMode,
      baseBranch: activeThreadBranch,
      startFromOrigin,
    };
    const draftId = newDraftId();
    rememberOptimisticRetractionComposer({ requestId, sourceThreadRef });
    const snapshotPromise = beginOptimisticRetraction({
      restoreComposer: () => {
        const restored = applyOptimisticRetractionRecoveryToThread({
          sourceThreadRef,
          bundle,
        });
        applyRestoredComposer(restored);
      },
      hideMessage: () =>
        onOptimisticRetractionStarted({ requestId, messageId: candidate.message.id }),
      dispatch: () => {
        const snapshot = snapshotLastUserMessageRecovery({
          requestId,
          messageId: candidate.message.id,
          sourceThreadRef,
          projectRef: activeProjectRef,
          draftId,
          futureThreadId: newThreadId(),
          createdAt,
          bundle,
          firstUserMessage: isFirstUserMessage,
          optimisticDestination: "thread",
        });
        const recovery = useRetractionRecoveryStore.getState().byRequestId[requestId];
        recoveryPreparationRef.current = false;
        if (recovery) void dispatchPendingRetraction(recovery);
        return snapshot;
      },
    });

    void snapshotPromise.then((snapshot) => {
      if (snapshot.failedImageNames.length === 0) return;
      toastManager.add({
        type: "warning",
        title: "Some images could not be saved for recovery",
        description: `${[...new Set(snapshot.failedImageNames)].join(", ")} may not survive a reconnect.`,
      });
    });

    if (!optimisticBundle && (candidate.message.attachments?.length ?? 0) > 0) {
      void captureLastUserMessageImages(candidate.message).then(async (captured) => {
        const appended = await appendImagesToOptimisticRetractionRecovery({
          requestId,
          sourceThreadRef,
          images: captured.images,
          bundle: {
            modelSelection: bundle.modelSelection,
            runtimeMode: bundle.runtimeMode,
            interactionMode: bundle.interactionMode,
            envMode: bundle.envMode,
            baseBranch: bundle.baseBranch,
            startFromOrigin: bundle.startFromOrigin,
          },
        });
        if (appended.restored) applyRestoredComposer(appended.restored);
        const failedNames = [...captured.failedNames, ...appended.failedImageNames];
        if (failedNames.length > 0) {
          toastManager.add({
            type: "warning",
            title: "Some images could not be restored",
            description: `${[...new Set(failedNames)].join(", ")} could not be restored to the composer.`,
          });
        }
      });
    }
  }, [
    activeProjectRef,
    activeThread,
    activeThreadBranch,
    candidate,
    dispatchPendingRetraction,
    envMode,
    interactionMode,
    isFirstUserMessage,
    onOptimisticRetractionStarted,
    optimisticBundle,
    retractionPending,
    runtimeMode,
    startFromOrigin,
    applyRestoredComposer,
  ]);
}
