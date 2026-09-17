import { CommandId, PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import type {
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
import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

import type { ComposerHandleRef } from "../../composerHandleContext";
import {
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type DraftThreadEnvMode,
} from "../../composerDraftStore";
import { prepareRevertedMessageAttachments } from "../ChatView.logic";
import { readPreparedConnection } from "../../state/session";
import { releaseDraftAttachments } from "../../lib/attachmentUploadQueue";
import { prepareLastUserMessageFiles } from "./lastUserMessageFiles";
import { newDraftId, newThreadId, randomUUID } from "../../lib/utils";
import { threadEnvironment } from "../../state/threads";
import { isFileAttachment, type Thread } from "../../types";
import { useAtomCommand } from "../../state/use-atom-command";
import { collapseExpandedComposerCursor } from "../../composer-logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { LastUserMessagePopCandidate } from "./lastUserMessagePop";
import type { PastedTextDraft } from "../../lib/pastedTextContext";
import {
  captureLastUserMessageImages,
  deriveLastUserMessageRestoredContent,
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
    files: ComposerFileAttachment[];
    pastedTexts: PastedTextDraft[];
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
  composerFilesRef: RefObject<ComposerFileAttachment[]>;
  createAttachmentAssetUrl: Parameters<
    typeof prepareRevertedMessageAttachments
  >[0]["createAssetUrl"];
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
    composerFilesRef,
    createAttachmentAssetUrl,
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
      composerFilesRef.current = restored.files;
      composerRef.current?.resetCursorState({
        cursor: collapseExpandedComposerCursor(restored.prompt, restored.prompt.length),
        prompt: restored.prompt,
        detectTrigger: true,
      });
      window.requestAnimationFrame(() => composerRef.current?.focusAtEnd());
      if (restored.unrestoredAttachmentNames.length > 0) {
        toastManager.add({
          type: "warning",
          title: "Some attachments could not be restored",
          description: `${restored.unrestoredAttachmentNames.join(", ")} could not be restored to the composer.`,
        });
      }
    },
    [composerImagesRef, composerFilesRef, composerRef, promptRef],
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

  const currentTargetRef = useRef<{
    activeThread: Thread | undefined;
    candidate: LastUserMessagePopCandidate | null;
  } | null>({ activeThread, candidate });
  useLayoutEffect(() => {
    currentTargetRef.current = { activeThread, candidate };
    return () => {
      currentTargetRef.current = null;
    };
  }, [activeThread, candidate]);
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

    const requestId = CommandId.make(randomUUID());
    const sourceThreadRef = scopeThreadRef(activeThread.environmentId, activeThread.id);
    const restoredContent = optimisticBundle
      ? null
      : deriveLastUserMessageRestoredContent(candidate.message);
    let prompt = optimisticBundle?.prompt ?? restoredContent?.prompt ?? "";
    let images = optimisticBundle?.images ?? [];
    const pastedTexts = optimisticBundle?.pastedTexts ?? restoredContent?.pastedTexts ?? [];
    const sourceFiles =
      optimisticBundle?.files ??
      (candidate.message.attachments ?? [])
        .filter(isFileAttachment)
        .map((attachment): ComposerFileAttachment => ({ ...attachment, file: null }));
    let files: ComposerFileAttachment[] = [];
    try {
      if (sourceFiles.length > 0) {
        const assertAttachmentRoom = () => {
          const current = useComposerDraftStore.getState().getComposerDraft(sourceThreadRef);
          const sentAttachmentCount = optimisticBundle
            ? images.length + sourceFiles.length
            : (candidate.message.attachments?.length ?? 0);
          if (
            (current?.images.length ?? 0) + (current?.files.length ?? 0) + sentAttachmentCount >
            PROVIDER_SEND_TURN_MAX_ATTACHMENTS
          ) {
            throw new Error(
              "Make room for this message's attachments in the composer before retracting.",
            );
          }
        };
        assertAttachmentRoom();
        const prepared = await prepareLastUserMessageFiles({
          environmentId: activeThread.environmentId,
          prompt,
          files: sourceFiles,
          loadFile: async (attachment) => {
            const connection = readPreparedConnection(activeThread.environmentId);
            if (!connection) throw new Error("The environment is not connected.");
            const restored = await prepareRevertedMessageAttachments({
              message: {
                ...candidate.message,
                attachments: [
                  candidate.message.attachments?.filter(isFileAttachment)[
                    sourceFiles.indexOf(attachment)
                  ] ?? attachment,
                ],
              },
              environmentId: activeThread.environmentId,
              httpBaseUrl: connection.httpBaseUrl,
              createAssetUrl: createAttachmentAssetUrl,
            });
            return restored[0]!;
          },
        });
        files = prepared.files;
        prompt = prepared.prompt;
        assertAttachmentRoom();
        if (!optimisticBundle) {
          const captured = await captureLastUserMessageImages({
            ...candidate.message,
            attachments:
              candidate.message.attachments?.filter((attachment) => attachment.type === "image") ??
              [],
          });
          if (captured.failedNames.length > 0) {
            throw new Error(`Could not restore attachments: ${captured.failedNames.join(", ")}`);
          }
          images = captured.images;
          assertAttachmentRoom();
        }
      }
    } catch (error) {
      releaseDraftAttachments(files);
      recoveryPreparationRef.current = false;
      toastManager.add({
        type: "error",
        title: "Message could not be retracted",
        description: errorMessage(error),
      });
      return;
    }
    if (
      currentTargetRef.current?.activeThread?.id !== activeThread.id ||
      currentTargetRef.current?.activeThread?.environmentId !== activeThread.environmentId ||
      currentTargetRef.current?.candidate?.message.id !== candidate.message.id
    ) {
      releaseDraftAttachments(files);
      recoveryPreparationRef.current = false;
      return;
    }
    const bundle = {
      prompt,
      images,
      files,
      pastedTexts,
      modelSelection: activeThread.modelSelection,
      runtimeMode,
      interactionMode,
      envMode,
      baseBranch: activeThreadBranch,
      startFromOrigin,
    };
    const createdAt = new Date().toISOString();
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

    if (
      !optimisticBundle &&
      sourceFiles.length === 0 &&
      candidate.message.attachments?.some((attachment) => attachment.type === "image")
    ) {
      void captureLastUserMessageImages({
        ...candidate.message,
        attachments: candidate.message.attachments.filter(
          (attachment) => attachment.type === "image",
        ),
      }).then(async (captured) => {
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
    createAttachmentAssetUrl,
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
