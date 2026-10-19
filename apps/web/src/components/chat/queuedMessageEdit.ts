import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import {
  pastedTextDraftFromRecord,
  pastedTextContextReference,
  resolveUserMessageContext,
} from "../../lib/composerContextRecords";
import type { ChatAttachment, OrchestrationMessageContext } from "@t3tools/contracts";
import {
  composerDraftHasUserContent,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadTarget,
} from "../../composerDraftStore";

/** Queued edits retain captured context, including records minted by another client. */
export function restoreQueuedMessagePastedTexts(message: {
  text: string;
  context?: OrchestrationMessageContext | undefined;
}) {
  const resolved = resolveUserMessageContext(message);
  const drafts = new Map(
    resolved.records.flatMap((record) =>
      record.kind === "pasted-text" && !("payload" in record)
        ? [[record.contextId, pastedTextDraftFromRecord(record)] as const]
        : [],
    ),
  );
  return {
    prompt: replaceComposerContextReferences(resolved.text, (reference) => {
      const draft = drafts.get(reference.contextId);
      return draft
        ? formatInlineContextReference(pastedTextContextReference(draft))
        : reference.source;
    }),
    pastedTexts: [...drafts.values()],
  };
}

export function recoverQueuedMessageEdit(input: {
  readonly editTarget: ComposerThreadTarget;
  readonly threadTarget: ComposerThreadTarget;
  readonly originalText: string;
  readonly originalContext?: OrchestrationMessageContext | undefined;
}): "kept" | "discarded" | "clean" {
  const store = useComposerDraftStore.getState();
  const draft = store.getComposerDraft(input.editTarget);
  const original = restoreQueuedMessagePastedTexts({
    text: input.originalText,
    context: input.originalContext,
  });
  const dirty =
    draft !== null &&
    (draft.prompt !== original.prompt ||
      draft.images.length > 0 ||
      draft.files.length > 0 ||
      draft.pastedTexts.length !== original.pastedTexts.length ||
      draft.pastedTexts.some(
        (paste) =>
          !original.pastedTexts.some(
            (previous) => previous.id === paste.id && previous.text === paste.text,
          ),
      ));
  if (dirty && !composerDraftHasUserContent(store.getComposerDraft(input.threadTarget))) {
    store.moveComposerPromptAndImages(input.editTarget, input.threadTarget);
    return "kept";
  }
  store.clearComposerContent(input.editTarget);
  return dirty ? "discarded" : "clean";
}

export async function prepareQueuedEditAttachments(input: {
  readonly existingAttachments: ReadonlyArray<ChatAttachment>;
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly files: ReadonlyArray<ComposerFileAttachment>;
  readonly uploadFiles: (
    files: ReadonlyArray<ComposerFileAttachment>,
  ) => Promise<ReadonlyArray<ChatAttachment>>;
  readonly readImage: (file: File) => Promise<string>;
}) {
  const files = input.files.length === 0 ? [] : await input.uploadFiles(input.files);
  if (files.length !== input.files.length)
    throw new Error("Retry or remove failed uploads before saving.");
  const images = await Promise.all(
    input.images.map(async (image) => ({
      type: "image" as const,
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl: await input.readImage(image.file),
      ...(image.source ? { source: image.source } : {}),
    })),
  );
  return [...input.existingAttachments, ...images, ...files];
}
