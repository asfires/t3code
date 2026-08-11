import type {
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
  findCorrelatedRetractionFailure,
  handoffCompletedMidThreadRetraction,
  type PendingRetractionRecovery,
  restoreRetractionRecoveryToThread,
  snapshotLastUserMessageRecovery,
  useRetractionRecoveryStore,
} from "./lastUserMessageRecovery";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

export function useLastUserMessageRetraction(input: {
  activeThread: Thread | undefined;
  activeProjectRef: ScopedProjectRef | null;
  activeThreadBranch: string | null;
  activeEnvironmentUnavailable: boolean;
  candidate: LastUserMessagePopCandidate | null;
  pendingRecovery: PendingRetractionRecovery | null;
  retractionPending: boolean;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  envMode: DraftThreadEnvMode;
  startFromOrigin: boolean;
  composerRef: ComposerHandleRef;
  promptRef: RefObject<string>;
  composerImagesRef: RefObject<ComposerImageAttachment[]>;
  setThreadError: (threadId: ThreadId | null, detail: string | null) => void;
}) {
  const {
    activeThread,
    activeProjectRef,
    activeThreadBranch,
    activeEnvironmentUnavailable,
    candidate,
    pendingRecovery,
    retractionPending,
    runtimeMode,
    interactionMode,
    envMode,
    startFromOrigin,
    composerRef,
    promptRef,
    composerImagesRef,
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
      const restored = restoreRetractionRecoveryToThread({
        requestId: recovery.requestId,
        sourceThreadRef: recovery.sourceThreadRef,
      });
      if (restored) applyRestoredComposer(restored);
      setThreadError(recovery.sourceThreadRef.threadId, detail);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Message restored, but the turn could not be retracted",
          description: detail,
        }),
      );
    },
    [applyRestoredComposer, setThreadError],
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
      if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
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
    [failPendingRetraction, retractThreadTurn],
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
    const activityFailure = findCorrelatedRetractionFailure(
      activeThread.activities,
      pendingRecovery.requestId,
    );
    const projectedFailure =
      activeThread.turnRetraction?.status === "failed" &&
      activeThread.turnRetraction.requestId === pendingRecovery.requestId;
    if (!projectedFailure && activityFailure === null) return;
    failPendingRetraction(
      pendingRecovery,
      activityFailure ?? "The server could not retract this message.",
    );
  }, [activeThread, failPendingRetraction, pendingRecovery]);

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
    const { images, failedNames } = await captureLastUserMessageImages(candidate.message).catch(
      () => ({
        images: [],
        failedNames: (candidate.message.attachments ?? []).map((attachment) => attachment.name),
      }),
    );
    const snapshot = await snapshotLastUserMessageRecovery({
      requestId,
      messageId: candidate.message.id,
      sourceThreadRef: scopeThreadRef(activeThread.environmentId, activeThread.id),
      projectRef: activeProjectRef,
      draftId: newDraftId(),
      futureThreadId: newThreadId(),
      createdAt,
      bundle: {
        prompt: deriveLastUserMessageRestoredText(candidate.message.text),
        images,
        modelSelection: activeThread.modelSelection,
        runtimeMode,
        interactionMode,
        envMode,
        baseBranch: activeThreadBranch,
        startFromOrigin,
      },
    });
    const unrestoredImageNames = [...failedNames, ...snapshot.failedImageNames];
    if (unrestoredImageNames.length > 0) {
      toastManager.add({
        type: "warning",
        title: "Some images could not be saved for recovery",
        description: `${[...new Set(unrestoredImageNames)].join(", ")} may not survive a reconnect.`,
      });
    }
    const recovery = useRetractionRecoveryStore.getState().byRequestId[requestId];
    recoveryPreparationRef.current = false;
    if (recovery) void dispatchPendingRetraction(recovery);
  }, [
    activeProjectRef,
    activeThread,
    activeThreadBranch,
    candidate,
    dispatchPendingRetraction,
    envMode,
    interactionMode,
    retractionPending,
    runtimeMode,
    startFromOrigin,
  ]);
}
