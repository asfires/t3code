import { isClosingFence, parseOpeningFence } from "../composer-rich-text-doc";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS, type ComposerContextRecord } from "@t3tools/contracts";
import { pastedTextDisposition, replaceTextSelection } from "@t3tools/client-runtime/text-paste";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import { pastedTextContextRecord, pastedTextContextReference } from "./composerContextRecords";
import { inlineContextReferenceReplacement } from "./composerContextReferences";
import type { PastedTextDraft } from "./pastedTextContext";

function fenceAtOffset(prompt: string, offset: number) {
  let fence: ReturnType<typeof parseOpeningFence> = null;
  let start = 0;
  for (const line of prompt.split("\n")) {
    if (offset <= start + line.length) return fence;
    fence = fence ? (isClosingFence(line, fence.fence) ? null : fence) : parseOpeningFence(line);
    start += line.length + 1;
  }
  return fence;
}

/** Test the actual post-paste prompt, including wrappers and only the records still referenced. */
export function planPastedText(input: {
  prompt: string;
  selection: { start: number; end: number };
  draft: PastedTextDraft;
  records: ReadonlyArray<ComposerContextRecord>;
  supportsRecords: boolean;
  richTextEnabled?: boolean;
  bypassAutoAttachment: boolean;
}) {
  const initialDisposition = pastedTextDisposition({
    text: input.draft.text,
    canAttach: true,
    supportsRecords: input.supportsRecords,
    bypassAutoAttachment: input.bypassAutoAttachment,
  });
  const asRecord = initialDisposition === "record";
  const edit = asRecord
    ? inlineContextReferenceReplacement(input.prompt, input.selection, [
        pastedTextContextReference(input.draft),
      ])
    : { ...input.selection, text: input.draft.text };
  if (asRecord && input.richTextEnabled) {
    // Rich code blocks accept only text. Close and reopen the fence so the pasted reference
    // remains an editable chip while the surrounding code stays literal.
    const before = fenceAtOffset(input.prompt, edit.start);
    const selectionEnd = Math.max(edit.start, Math.min(input.prompt.length, input.selection.end));
    const after = fenceAtOffset(input.prompt, selectionEnd);
    if (before || after) {
      edit.end = selectionEnd;
      edit.text = `${before ? `\n${before.fence}\n` : ""}${edit.text.trim()}${after ? `\n${after.fence}${after.language}\n` : ""}`;
    }
  }
  const prompt = replaceTextSelection({
    value: input.prompt,
    selection: edit,
    text: edit.text,
  }).value;
  const projected = projectComposerContextForProvider({
    text: prompt,
    records: asRecord ? [...input.records, pastedTextContextRecord(input.draft)] : input.records,
  });
  const wouldExceedInputLimit = projected.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
  return {
    edit,
    disposition: pastedTextDisposition({
      text: input.draft.text,
      canAttach: true,
      supportsRecords: input.supportsRecords,
      bypassAutoAttachment: input.bypassAutoAttachment,
      wouldExceedInputLimit,
    }),
    wouldExceedInputLimit,
  };
}
