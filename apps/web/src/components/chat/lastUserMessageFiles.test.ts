import { CommandId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import {
  DraftId,
  useComposerDraftStore,
  type ComposerFileAttachment,
} from "../../composerDraftStore";
import { fileContextReference } from "../../lib/composerContextRecords";
import { formatInlineContextReference } from "../../lib/composerContextReferences";

const mocks = vi.hoisted(() => ({
  createUploadUrl: Symbol("create-upload-url"),
  removeUpload: Symbol("remove-upload"),
  runAtomCommand: vi.fn(),
  executeAtomQuery: vi.fn(),
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  runAtomCommand: mocks.runAtomCommand,
  executeAtomQuery: mocks.executeAtomQuery,
  squashAtomCommandFailure: (result: { error: unknown }) => result.error,
}));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/attachments", () => ({
  attachmentEnvironment: { createUploadUrl: mocks.createUploadUrl, remove: mocks.removeUpload },
}));
vi.mock("../../state/assets", () => ({
  assetEnvironment: { createUrl: (input: unknown) => input },
}));
vi.mock("../../state/session", () => ({
  readPreparedConnection: () => ({ httpBaseUrl: "https://environment.test/" }),
}));

import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseDraftAttachment,
  releaseAttachmentUpload,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "../../lib/attachmentUploadQueue";
import { prepareLastUserMessageFiles } from "./lastUserMessageFiles";
import {
  rememberOptimisticRetractionComposer,
  restoreOptimisticRetractionComposer,
} from "./lastUserMessageRecovery";

class UploadRequest {
  static status = 204;
  status = UploadRequest.status;
  listeners = new Map<string, () => void>();
  upload = { addEventListener: vi.fn() };
  open() {}
  setRequestHeader() {}
  addEventListener(event: string, listener: () => void) {
    this.listeners.set(event, listener);
  }
  send() {
    queueMicrotask(() => this.listeners.get("load")?.());
  }
  abort() {
    this.listeners.get("abort")?.();
  }
}

const environmentId = EnvironmentId.make("environment-1");
const draftId = DraftId.make("restored-draft");
const text = "large pasted text\n".repeat(10_000);
function attachment(): ComposerFileAttachment {
  const file = new File([text], "pasted-text-4.txt", { type: "text/plain" });
  return {
    type: "file",
    id: "original-file",
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    file,
    source: { _tag: "pasted-text" },
  };
}

beforeEach(() => {
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  mocks.runAtomCommand.mockReset();
  mocks.executeAtomQuery.mockReset();
  mocks.executeAtomQuery.mockResolvedValue({ _tag: "Success", value: {} });
  let nextId = 0;
  mocks.runAtomCommand.mockImplementation(async (_registry, command) => {
    if (command === mocks.createUploadUrl) {
      const attachmentId = `pending-${++nextId}-txt`;
      return {
        _tag: "Success",
        value: { attachmentId, relativeUrl: `/upload/${attachmentId}`, expiresAt: 1 },
      };
    }
    return { _tag: "Success", value: undefined };
  });
  UploadRequest.status = 204;
  vi.stubGlobal("XMLHttpRequest", UploadRequest);
});

afterEach(() => {
  for (const id of Object.keys(useAttachmentUploadStore.getState().uploadsByImageId)) {
    releaseAttachmentUpload(id);
  }
  vi.unstubAllGlobals();
});

it("preserves all pasted bytes and references for resend independently of the original upload", async () => {
  const original = attachment();
  startAttachmentUpload({ environmentId, image: original });
  await awaitAttachmentUploads([original.id]);
  const originalUpload = getUploadedAttachments({ environmentId, images: [original] })![0]!;
  const originalLink = formatInlineContextReference(fileContextReference(original));
  const loadFile = vi.fn();
  const restored = await prepareLastUserMessageFiles({
    environmentId,
    files: [original],
    prompt: `Read ${originalLink} twice ${originalLink}`,
    loadFile,
  });
  releaseDraftAttachment(original);
  expect(loadFile).not.toHaveBeenCalled();
  expect(await restored.files[0]!.file!.text()).toBe(text);
  const link = formatInlineContextReference(fileContextReference(restored.files[0]!));
  expect(restored.prompt).toBe(`Read ${link} twice ${link}`);
  const resent = getUploadedAttachments({ environmentId, images: restored.files })!;
  expect(resent[0]!.id).not.toBe(originalUpload.id);
  expect(resent[0]).toMatchObject({
    name: original.name,
    sizeBytes: original.sizeBytes,
    source: original.source,
  });
});

it("fetches missing local bytes and persists a pending reference that can resend after reload", async () => {
  const original = attachment();
  const loadFile = vi.fn(async () => original.file!);
  const restored = await prepareLastUserMessageFiles({
    environmentId,
    files: [{ ...original, file: null }],
    prompt: "Read this",
    loadFile,
  });
  expect(loadFile).toHaveBeenCalledOnce();
  const file = restored.files[0]!;
  const merged = useComposerDraftStore.persist.getOptions().merge!(
    {
      draftsByThreadKey: {
        [draftId]: {
          prompt: restored.prompt,
          files: [
            {
              id: file.id,
              name: file.name,
              mimeType: file.mimeType,
              sizeBytes: file.sizeBytes,
              source: file.source,
              attachmentId: file.uploadedAttachmentId,
              environmentId: file.uploadEnvironmentId,
            },
          ],
        },
      },
    },
    useComposerDraftStore.getInitialState(),
  );
  const hydrated = merged.draftsByThreadKey[draftId]!.files[0]!;
  expect(hydrated.file).toBeNull();
  useAttachmentUploadStore.setState({ uploadsByImageId: {} });
  startAttachmentUpload({ environmentId, image: hydrated });
  await awaitAttachmentUploads([hydrated.id]);
  expect(getUploadedAttachments({ environmentId, images: [hydrated] })![0]!.id).toBe(
    file.uploadedAttachmentId,
  );
});

it("deleting a restored badge removes its reference and releases its pending upload", async () => {
  const restored = await prepareLastUserMessageFiles({
    environmentId,
    prompt: "",
    files: [attachment()],
    loadFile: vi.fn(),
  });
  const store = useComposerDraftStore.getState();
  store.setPrompt(draftId, restored.prompt);
  store.addFiles(draftId, restored.files);
  const file = restored.files[0]!;
  store.removeFile(draftId, file.id);
  releaseDraftAttachment(file);
  expect(store.getComposerDraft(draftId)?.files ?? []).toEqual([]);
  expect(store.getComposerDraft(draftId)?.prompt ?? "").toBe("");
  expect(mocks.runAtomCommand).toHaveBeenCalledWith(
    expect.anything(),
    mocks.removeUpload,
    {
      environmentId,
      input: { attachmentId: file.uploadedAttachmentId },
    },
    expect.anything(),
  );
});

it("fails preparation when the sent file cannot be downloaded", async () => {
  await expect(
    prepareLastUserMessageFiles({
      environmentId,
      prompt: "",
      files: [{ ...attachment(), file: null }],
      loadFile: async () => {
        throw new Error("attachment missing");
      },
    }),
  ).rejects.toThrow("attachment missing");
  expect(mocks.runAtomCommand).not.toHaveBeenCalled();
});

it("releases the recovery upload when the server rejects a late retraction", async () => {
  const sourceThreadRef = scopeThreadRef(environmentId, ThreadId.make("source-thread"));
  const requestId = CommandId.make("late-retraction");
  const store = useComposerDraftStore.getState();
  store.setPrompt(sourceThreadRef, "unsent draft");
  rememberOptimisticRetractionComposer({ requestId, sourceThreadRef });
  const recovered = await prepareLastUserMessageFiles({
    environmentId,
    prompt: "sent prompt",
    files: [attachment()],
    loadFile: vi.fn(),
  });
  store.addFiles(sourceThreadRef, recovered.files);
  store.setPrompt(sourceThreadRef, recovered.prompt);
  expect(restoreOptimisticRetractionComposer(requestId)).toMatchObject({
    prompt: "unsent draft",
    files: [],
  });
  expect(getUploadedAttachments({ environmentId, images: recovered.files })).toBeNull();
  expect(store.getComposerDraft(sourceThreadRef)?.prompt).toBe("unsent draft");
});

it("cleans up a failed recovery upload without releasing the original attachment", async () => {
  UploadRequest.status = 500;
  await expect(
    prepareLastUserMessageFiles({
      environmentId,
      prompt: "",
      files: [attachment()],
      loadFile: vi.fn(),
    }),
  ).rejects.toThrow("Could not save attachment");
  expect(useAttachmentUploadStore.getState().uploadsByImageId).toEqual({});
  expect(mocks.runAtomCommand).toHaveBeenCalledWith(
    expect.anything(),
    mocks.removeUpload,
    {
      environmentId,
      input: { attachmentId: "pending-1-txt" },
    },
    expect.anything(),
  );
});
