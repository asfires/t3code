import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS, type ComposerContextRecord } from "@t3tools/contracts";
import { pastedTextDisposition, replaceTextSelection } from "@t3tools/client-runtime/text-paste";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import { pastedTextContextRecord, pastedTextContextReference } from "./composerContextRecords";
import { inlineContextReferenceReplacement } from "./composerContextReferences";
import type { PastedTextDraft } from "./pastedTextContext";

/** Test the actual post-paste prompt, including wrappers and only the records still referenced. */
export function planPastedText(input: {
  prompt: string;
  selection: { start: number; end: number };
  draft: PastedTextDraft;
  records: ReadonlyArray<ComposerContextRecord>;
  supportsRecords: boolean;
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
