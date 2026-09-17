import type { EnvironmentId } from "@t3tools/contracts";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";

import type { ComposerFileAttachment } from "../../composerDraftStore";
import {
  awaitAttachmentUploads,
  readAttachmentUpload,
  releaseDraftAttachments,
  startAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { fileContextReference } from "../../lib/composerContextRecords";
import {
  ensureInlineContextReferences,
  formatInlineContextReference,
} from "../../lib/composerContextReferences";
import { randomUUID } from "../../lib/utils";

/** Save independent pending uploads before retraction can prune the sent attachments. */
export async function prepareLastUserMessageFiles(input: {
  environmentId: EnvironmentId;
  prompt: string;
  files: ReadonlyArray<ComposerFileAttachment>;
  loadFile: (attachment: ComposerFileAttachment) => Promise<File>;
}): Promise<{ prompt: string; files: ComposerFileAttachment[] }> {
  const files = await Promise.all(
    input.files.map(async (attachment): Promise<ComposerFileAttachment> => ({
      type: "file",
      id: randomUUID(),
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      ...(attachment.source ? { source: attachment.source } : {}),
      file: attachment.file ?? (await input.loadFile(attachment)),
    })),
  );
  try {
    for (const file of files) {
      startAttachmentUpload({ environmentId: input.environmentId, image: file });
    }
    await awaitAttachmentUploads(files.map((file) => file.id));
    for (const file of files) {
      const upload = readAttachmentUpload(file.id);
      if (upload?.status !== "ready" || upload.environmentId !== input.environmentId) {
        throw new Error(`Could not save attachment for retraction: ${file.name}`);
      }
      file.uploadedAttachmentId = upload.attachmentId;
      file.uploadEnvironmentId = upload.environmentId;
    }
  } catch (error) {
    releaseDraftAttachments(files);
    throw error;
  }

  const replacements = new Map(
    input.files.map((file, index) => [fileContextReference(file).contextId, files[index]!]),
  );
  const prompt = replaceComposerContextReferences(input.prompt, (reference) => {
    const file = replacements.get(reference.contextId);
    return file ? formatInlineContextReference(fileContextReference(file)) : reference.source;
  });
  return {
    prompt: ensureInlineContextReferences(prompt, files.map(fileContextReference)),
    files,
  };
}
