import type {
  CommandId,
  MessageId,
  ModelSelection,
  OrchestrationThreadActivity,
  ProviderInteractionMode,
  RuntimeMode,
  ScopedProjectRef,
  ScopedThreadRef,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  type ComposerImageAttachment,
  type DraftId,
  type DraftThreadEnvMode,
  type PersistedComposerImageAttachment,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { resolveStorage } from "../../lib/storage";
import { cloneComposerImageForRetry, readFileAsDataUrl } from "../ChatView.logic";
import { mergePoppedPrompt } from "./lastUserMessagePop";

const RETRACTION_RECOVERY_STORAGE_KEY = "t3code:thread-retraction-recoveries:v1";

export interface PendingRetractionRecovery {
  requestId: CommandId;
  messageId: MessageId;
  sourceThreadRef: ScopedThreadRef;
  projectRef: ScopedProjectRef;
  draftId: DraftId;
  createdAt: string;
}

export function buildRetractionCommandInput(recovery: PendingRetractionRecovery) {
  return {
    commandId: recovery.requestId,
    threadId: recovery.sourceThreadRef.threadId,
    messageId: recovery.messageId,
    createdAt: recovery.createdAt,
  };
}

interface RetractionRecoveryStoreState {
  byRequestId: Record<string, PendingRetractionRecovery>;
  remember: (recovery: PendingRetractionRecovery) => void;
  forget: (requestId: CommandId) => void;
}

let recoveryStorage: Storage | undefined;
try {
  recoveryStorage = typeof localStorage === "undefined" ? undefined : localStorage;
} catch {
  recoveryStorage = undefined;
}

export const useRetractionRecoveryStore = create<RetractionRecoveryStoreState>()(
  persist(
    (set) => ({
      byRequestId: {},
      remember: (recovery) =>
        set((state) => ({
          byRequestId: { ...state.byRequestId, [recovery.requestId]: recovery },
        })),
      forget: (requestId) =>
        set((state) => {
          if (state.byRequestId[requestId] === undefined) return state;
          const { [requestId]: _forgotten, ...byRequestId } = state.byRequestId;
          return { byRequestId };
        }),
    }),
    {
      name: RETRACTION_RECOVERY_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => resolveStorage(recoveryStorage)),
      partialize: (state) => ({ byRequestId: state.byRequestId }),
    },
  ),
);

export interface LastUserMessageRestoreBundle {
  prompt: string;
  images: ComposerImageAttachment[];
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  envMode: DraftThreadEnvMode;
  baseBranch: string | null;
  startFromOrigin: boolean;
}

export interface FirstMessageRetractionCompletion {
  threadId: ThreadId;
  retraction?: {
    requestId: CommandId;
    messageId: MessageId;
    turnId: TurnId | null;
    firstUserMessage: boolean;
    completedAt: string;
  };
}

export async function snapshotLastUserMessageRecovery(input: {
  requestId: CommandId;
  messageId: MessageId;
  sourceThreadRef: ScopedThreadRef;
  projectRef: ScopedProjectRef;
  draftId: DraftId;
  futureThreadId: ThreadId;
  createdAt: string;
  bundle: LastUserMessageRestoreBundle;
  encodeImage?: (file: File) => Promise<string>;
}): Promise<{ draftId: DraftId; failedImageNames: string[] }> {
  const store = useComposerDraftStore.getState();
  store.createUnmappedDraftSession(input.projectRef, input.draftId, {
    threadId: input.futureThreadId,
    createdAt: input.createdAt,
    runtimeMode: input.bundle.runtimeMode,
    interactionMode: input.bundle.interactionMode,
    envMode: input.bundle.envMode,
    branch: input.bundle.baseBranch,
    worktreePath: null,
    startFromOrigin: input.bundle.startFromOrigin,
    hidden: true,
  });
  store.setPrompt(input.draftId, input.bundle.prompt);
  store.addImages(input.draftId, input.bundle.images);
  store.setModelSelection(input.draftId, input.bundle.modelSelection, { replaceOptions: true });
  store.setRuntimeMode(input.draftId, input.bundle.runtimeMode);
  store.setInteractionMode(input.draftId, input.bundle.interactionMode);

  const encodeImage = input.encodeImage ?? readFileAsDataUrl;
  const encoded = await Promise.all(
    input.bundle.images.map(async (image) => {
      try {
        const dataUrl = await encodeImage(image.file);
        return {
          attachment: {
            id: image.id,
            name: image.name,
            mimeType: image.mimeType,
            sizeBytes: image.sizeBytes,
            dataUrl,
          } satisfies PersistedComposerImageAttachment,
          failedName: null,
        };
      } catch {
        return { attachment: null, failedName: image.name };
      }
    }),
  );
  store.syncPersistedAttachments(
    input.draftId,
    encoded.flatMap((entry) => (entry.attachment ? [entry.attachment] : [])),
  );

  useRetractionRecoveryStore.getState().remember({
    requestId: input.requestId,
    messageId: input.messageId,
    sourceThreadRef: input.sourceThreadRef,
    projectRef: input.projectRef,
    draftId: input.draftId,
    createdAt: input.createdAt,
  });

  return {
    draftId: input.draftId,
    failedImageNames: encoded.flatMap((entry) => (entry.failedName ? [entry.failedName] : [])),
  };
}

export interface AppliedRetractionRecovery {
  prompt: string;
  images: ComposerImageAttachment[];
  unrestoredImageNames: string[];
}

export function findCorrelatedRetractionFailure(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  requestId: CommandId,
): string | null {
  const activity = activities.findLast((entry) => {
    if (entry.kind !== "turn.retract.failed" || typeof entry.payload !== "object") return false;
    return (entry.payload as { requestId?: unknown } | null)?.requestId === requestId;
  });
  if (!activity) return null;
  const detail = (activity.payload as { detail?: unknown } | null)?.detail;
  return typeof detail === "string" && detail.trim().length > 0 ? detail : activity.summary;
}

export function restoreRetractionRecoveryToThread(input: {
  requestId: CommandId;
  sourceThreadRef: ScopedThreadRef;
}): AppliedRetractionRecovery | null {
  const recovery = useRetractionRecoveryStore.getState().byRequestId[input.requestId];
  if (
    !recovery ||
    recovery.sourceThreadRef.environmentId !== input.sourceThreadRef.environmentId ||
    recovery.sourceThreadRef.threadId !== input.sourceThreadRef.threadId
  ) {
    return null;
  }

  const store = useComposerDraftStore.getState();
  const recoveredDraft = store.getComposerDraft(recovery.draftId);
  if (!recoveredDraft) return null;

  const currentDraft = store.getComposerDraft(input.sourceThreadRef);
  const prompt = mergePoppedPrompt(currentDraft?.prompt ?? "", recoveredDraft.prompt);
  const existingImages = currentDraft?.images ?? [];
  const existingIds = new Set(existingImages.map((image) => image.id));
  const existingKeys = new Set(
    existingImages.map((image) => JSON.stringify([image.mimeType, image.sizeBytes, image.name])),
  );
  const images: ComposerImageAttachment[] = [];
  const unrestoredImageNames: string[] = [];
  for (const recoveredImage of recoveredDraft.images) {
    const key = JSON.stringify([
      recoveredImage.mimeType,
      recoveredImage.sizeBytes,
      recoveredImage.name,
    ]);
    if (existingIds.has(recoveredImage.id) || existingKeys.has(key)) continue;
    if (existingImages.length + images.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      unrestoredImageNames.push(recoveredImage.name);
      continue;
    }
    existingIds.add(recoveredImage.id);
    existingKeys.add(key);
    images.push(cloneComposerImageForRetry(recoveredImage));
  }

  store.setPrompt(input.sourceThreadRef, prompt);
  store.addImages(input.sourceThreadRef, images);
  const recoveredModelSelection = recoveredDraft.activeProvider
    ? recoveredDraft.modelSelectionByProvider[recoveredDraft.activeProvider]
    : undefined;
  store.setModelSelection(input.sourceThreadRef, recoveredModelSelection, {
    replaceOptions: true,
  });
  store.setRuntimeMode(input.sourceThreadRef, recoveredDraft.runtimeMode);
  store.setInteractionMode(input.sourceThreadRef, recoveredDraft.interactionMode);
  store.clearDraftThread(recovery.draftId);
  useRetractionRecoveryStore.getState().forget(input.requestId);

  return {
    prompt,
    images: [...existingImages, ...images],
    unrestoredImageNames,
  };
}

export function handoffCompletedMidThreadRetraction(input: {
  environmentId: ScopedThreadRef["environmentId"];
  completion: FirstMessageRetractionCompletion;
}): AppliedRetractionRecovery | null {
  const metadata = input.completion.retraction;
  if (!metadata || metadata.firstUserMessage) return null;
  return restoreRetractionRecoveryToThread({
    requestId: metadata.requestId,
    sourceThreadRef: {
      environmentId: input.environmentId,
      threadId: input.completion.threadId,
    },
  });
}

export function handoffCompletedFirstMessageRetraction(input: {
  capabilityEnabled: boolean;
  environmentId: ScopedThreadRef["environmentId"];
  completion: FirstMessageRetractionCompletion;
  navigate: (input: {
    to: "/draft/$draftId";
    params: { draftId: DraftId };
    replace: true;
  }) => unknown;
}): boolean {
  const metadata = input.completion.retraction;
  if (!input.capabilityEnabled || !metadata?.firstUserMessage) return false;

  const recovery = useRetractionRecoveryStore.getState().byRequestId[metadata.requestId];
  if (
    !recovery ||
    recovery.sourceThreadRef.environmentId !== input.environmentId ||
    recovery.sourceThreadRef.threadId !== input.completion.threadId
  ) {
    return false;
  }

  const composerStore = useComposerDraftStore.getState();
  const session = composerStore.getDraftSession(recovery.draftId);
  if (!session) return false;

  composerStore.setProjectDraftThreadId(recovery.projectRef, recovery.draftId, {
    threadId: session.threadId,
    createdAt: session.createdAt,
    runtimeMode: session.runtimeMode,
    interactionMode: session.interactionMode,
    branch: session.branch,
    worktreePath: null,
    envMode: session.envMode,
    startFromOrigin: session.startFromOrigin,
    hidden: false,
  });
  useRetractionRecoveryStore.getState().forget(metadata.requestId);
  void input.navigate({
    to: "/draft/$draftId",
    params: { draftId: recovery.draftId },
    replace: true,
  });
  return true;
}
