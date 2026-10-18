import { ComposerContextId } from "@t3tools/contracts";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import { buildMessageContext } from "../../lib/composerContextRecords";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  DraftId,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../../composerDraftStore";
import {
  prepareQueuedEditAttachments,
  recoverQueuedMessageEdit,
  restoreQueuedMessagePastedTexts,
} from "./queuedMessageEdit";

const environmentId = EnvironmentId.make("remote-environment");
const threadTarget = scopeThreadRef(environmentId, ThreadId.make("thread:edit"));
const editTarget = DraftId.make("queued-edit:test");
const file: ComposerFileAttachment = {
  type: "file",
  id: "file:report",
  name: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 6,
  file: new File(["report"], "report.pdf", { type: "application/pdf" }),
};
const image: ComposerImageAttachment = {
  type: "image",
  id: "image:screen",
  name: "screen.png",
  mimeType: "image/png",
  sizeBytes: 5,
  file: new File(["image"], "screen.png", { type: "image/png" }),
  previewUrl: "blob:screen",
};
const uploadedFile = {
  type: "file" as const,
  id: "upload:report",
  name: file.name,
  mimeType: file.mimeType,
  sizeBytes: file.sizeBytes,
};

describe("queued message file edits", () => {
  beforeEach(() => {
    useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  });

  it.each([
    { images: [], label: "file-only" },
    { images: [image], label: "mixed" },
  ])("preserves a generic file in a $label save", async ({ images }) => {
    const attachments = await prepareQueuedEditAttachments({
      existingAttachments: [],
      images,
      files: [file],
      uploadFiles: async () => [uploadedFile],
      readImage: async () => "data:image/png;base64,aW1hZ2U=",
    });
    expect(attachments.at(-1)).toEqual(uploadedFile);
    expect(attachments.length).toBe(images.length + 1);
    if (images.length > 0)
      expect(attachments[0]).toMatchObject({
        type: "image",
        dataUrl: "data:image/png;base64,aW1hZ2U=",
      });
  });

  it("retains saved attachments alongside newly uploaded files", async () => {
    const saved = { ...uploadedFile, id: "saved:earlier" };
    const attachments = await prepareQueuedEditAttachments({
      existingAttachments: [saved],
      images: [],
      files: [file],
      uploadFiles: async () => [uploadedFile],
      readImage: async () => "unused",
    });
    expect(attachments).toEqual([saved, uploadedFile]);
  });

  it("fails a save instead of dropping a file whose upload is missing", async () => {
    await expect(
      prepareQueuedEditAttachments({
        existingAttachments: [],
        images: [image],
        files: [file],
        uploadFiles: async () => [],
        readImage: async () => "image",
      }),
    ).rejects.toThrow("Retry or remove");
  });

  it("keeps file-only edits when another client starts the queued run", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(editTarget, "Original message");
    store.addFiles(editTarget, [file]);
    expect(
      recoverQueuedMessageEdit({ editTarget, threadTarget, originalText: "Original message" }),
    ).toBe("kept");
    expect(store.getComposerDraft(threadTarget)?.prompt).toBe("Original message");
    expect(store.getComposerDraft(threadTarget)?.files).toEqual([file]);
    expect(store.getComposerDraft(editTarget)).toBeNull();
  });

  it("preserves uploaded file references when a remote queue advance interrupts the edit", () => {
    const store = useComposerDraftStore.getState();
    const uploaded = {
      ...file,
      file: null,
      uploadedAttachmentId: uploadedFile.id,
      uploadEnvironmentId: environmentId,
    };
    store.addFiles(editTarget, [uploaded]);
    expect(recoverQueuedMessageEdit({ editTarget, threadTarget, originalText: "" })).toBe("kept");
    expect(store.getComposerDraft(threadTarget)?.files).toEqual([uploaded]);
  });

  it("does not overwrite a separate draft when the queued run leaves", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(threadTarget, "Separate draft");
    store.addFiles(editTarget, [file]);
    expect(recoverQueuedMessageEdit({ editTarget, threadTarget, originalText: "" })).toBe(
      "discarded",
    );
    expect(store.getComposerDraft(threadTarget)?.prompt).toBe("Separate draft");
    expect(store.getComposerDraft(editTarget)).toBeNull();
  });
});

describe("queued pasted-text edits", () => {
  const context = {
    version: 1 as const,
    records: [
      {
        version: 1 as const,
        kind: "pasted-text" as const,
        contextId: ComposerContextId.make("foreign_paste"),
        label: "Pasted text",
        text: "x".repeat(100_000) + "\nlast line",
      },
    ],
  };
  const text = "Read [Pasted text](t3-context://v1/pasted-text/foreign_paste)";

  beforeEach(() => {
    useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  });

  it("restores a foreign chip and sends its edited contents inline", () => {
    const restored = restoreQueuedMessagePastedTexts({ text, context });
    const store = useComposerDraftStore.getState();
    store.setPastedTexts(editTarget, restored.pastedTexts);
    store.setPrompt(editTarget, restored.prompt);
    store.updatePastedText(editTarget, restored.pastedTexts[0]!.id, "edited tail");
    const draft = store.getComposerDraft(editTarget)!;
    const outgoing = buildMessageContext(draft);
    expect(
      projectComposerContextForProvider({ text: draft.prompt, records: outgoing?.records ?? [] }),
    ).toContain("edited tail");
    expect(draft.prompt).toContain("pasted-text_foreign_paste");
  });

  it("keeps a paste-only edit when another client advances the queue", () => {
    const store = useComposerDraftStore.getState();
    const restored = restoreQueuedMessagePastedTexts({ text, context });
    store.setPastedTexts(editTarget, restored.pastedTexts);
    store.setPrompt(editTarget, restored.prompt);
    const edited = context.records[0]!.text + " changed";
    store.updatePastedText(editTarget, restored.pastedTexts[0]!.id, edited);
    expect(
      recoverQueuedMessageEdit({
        editTarget,
        threadTarget,
        originalText: text,
        originalContext: context,
      }),
    ).toBe("kept");
    const recovered = store.getComposerDraft(threadTarget)!;
    expect(recovered.prompt).toBe(restored.prompt);
    expect(recovered.pastedTexts[0]?.text).toBe(edited);
    expect(store.getComposerDraft(editTarget)).toBeNull();
  });

  it("does not recover an unchanged chip as a new draft", () => {
    const store = useComposerDraftStore.getState();
    const restored = restoreQueuedMessagePastedTexts({ text, context });
    store.setPastedTexts(editTarget, restored.pastedTexts);
    store.setPrompt(editTarget, restored.prompt);
    expect(
      recoverQueuedMessageEdit({
        editTarget,
        threadTarget,
        originalText: text,
        originalContext: context,
      }),
    ).toBe("clean");
    expect(store.getComposerDraft(threadTarget)).toBeNull();
  });
});
