import { buildTiptapContent } from "../composer-rich-text-doc";
import { replaceTextSelection } from "@t3tools/client-runtime/text-paste";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import { getComposerSubmissionValidationMessage } from "../components/chat/composerSubmission";
import { describe, expect, it } from "vite-plus/test";
import { planPastedText } from "./pastedTextPaste";
import { pastedTextContextRecord, pastedTextContextReference } from "./composerContextRecords";
import { formatInlineContextReference } from "./composerContextReferences";

const draft = (id: string, text: string) => ({ id, text, createdAt: "2026-09-17T12:00:00.000Z" });
const original = draft("original", "x".repeat(100_000));
const chip = formatInlineContextReference(pastedTextContextReference(original));
const base = {
  prompt: "",
  selection: { start: 0, end: 0 },
  records: [],
  supportsRecords: true,
  bypassAutoAttachment: false,
};

describe("planPastedText", () => {
  it("attaches a paste that fits as raw text but exceeds the limit with its wrapper", () => {
    expect(planPastedText({ ...base, draft: draft("new", "x".repeat(119_900)) })).toMatchObject({
      disposition: "attachment",
      wouldExceedInputLimit: true,
    });
    expect(planPastedText({ ...base, draft: draft("new", "x".repeat(119_000)) }).disposition).toBe(
      "record",
    );
  });

  it("counts escaping added by provider projection", () => {
    expect(
      planPastedText({ ...base, draft: draft("new", "<context>".repeat(12_000)) }).disposition,
    ).toBe("attachment");
  });

  it("replaces the selected chip without counting its removed payload", () => {
    expect(
      planPastedText({
        ...base,
        prompt: chip,
        selection: { start: 0, end: chip.length },
        records: [pastedTextContextRecord(original)],
        draft: draft("new", "y".repeat(50_000)),
      }),
    ).toMatchObject({ disposition: "record", wouldExceedInputLimit: false });
  });

  it("still counts a payload when another reference survives the selection", () => {
    expect(
      planPastedText({
        ...base,
        prompt: `${chip} ${chip}`,
        selection: { start: 0, end: chip.length },
        records: [pastedTextContextRecord(original)],
        draft: draft("new", "y".repeat(50_000)),
      }).disposition,
    ).toBe("attachment");
  });

  it("ignores unreferenced records and counts other referenced context", () => {
    const records = [pastedTextContextRecord(original)];
    expect(
      planPastedText({ ...base, records, draft: draft("new", "y".repeat(50_000)) }).disposition,
    ).toBe("record");
    expect(
      planPastedText({ ...base, prompt: chip, records, draft: draft("new", "y".repeat(50_000)) })
        .disposition,
    ).toBe("attachment");
  });

  it("keeps plain-text bypass and the question-answer attachment threshold", () => {
    expect(
      planPastedText({
        ...base,
        bypassAutoAttachment: true,
        draft: draft("new", "x".repeat(130_000)),
      }).disposition,
    ).toBe("inline");
    expect(
      planPastedText({ ...base, supportsRecords: false, draft: draft("new", "x".repeat(33_000)) })
        .disposition,
    ).toBe("attachment");
  });
});

it("rejects an edited chip beyond the provider limit without truncating its draft", () => {
  const pasted = draft("edited", "x".repeat(130_000) + " tail");
  const prompt = formatInlineContextReference(pastedTextContextReference(pasted));
  const record = pastedTextContextRecord(pasted);
  const providerInput = projectComposerContextForProvider({ text: prompt, records: [record] });
  expect(
    getComposerSubmissionValidationMessage({
      prompt,
      providerInput,
      submissionTarget: "provider-turn",
    }),
  ).toContain("over the 120,000-character limit");
  expect(record.text).toBe(pasted.text);
  expect(providerInput).toContain(" tail");
});

it.each(["```ts", "~~~~json"])("keeps a folded paste editable inside a %s fence", (opening) => {
  const fence = opening.match(/^[`~]+/)![0];
  const prompt = `${opening}\nbefore selected after\n${fence}`;
  const start = prompt.indexOf("selected");
  const plan = planPastedText({
    ...base,
    richTextEnabled: true,
    prompt,
    selection: { start, end: start + "selected".length },
    draft: draft("code-paste", "x".repeat(1_000)),
  });
  expect(plan.disposition).toBe("record");
  const next = replaceTextSelection({
    value: prompt,
    selection: plan.edit,
    text: plan.edit.text,
  }).value;
  const content = buildTiptapContent(next, (name) => ({ label: name, description: null }));
  expect(content).toMatchObject([
    { type: "codeBlock", content: [{ type: "text", text: "before " }] },
    {
      type: "paragraph",
      content: [{ type: "composer-context-reference", attrs: { kind: "pasted-text" } }],
    },
    { type: "codeBlock", content: [{ type: "text", text: " after" }] },
  ]);
  const inline = planPastedText({
    ...base,
    richTextEnabled: true,
    prompt,
    selection: { start, end: start + "selected".length },
    draft: draft("code-paste", "x".repeat(1_000)),
    bypassAutoAttachment: true,
  });
  expect(inline.disposition).toBe("inline");
  expect(inline.edit.text).toBe("x".repeat(1_000));
});

it("does not add fences when rich text is disabled", () => {
  const prompt = "```ts\nbefore selected after\n```";
  const start = prompt.indexOf("selected");
  const pasted = draft("plain-paste", "x".repeat(1_000));
  const plan = planPastedText({
    ...base,
    prompt,
    selection: { start, end: start + "selected".length },
    draft: pasted,
    richTextEnabled: false,
  });
  expect(plan.disposition).toBe("record");
  const next = replaceTextSelection({
    value: prompt,
    selection: plan.edit,
    text: plan.edit.text,
  }).value;
  expect(next).toBe(
    `\`\`\`ts\nbefore ${formatInlineContextReference(pastedTextContextReference(pasted))} after\n\`\`\``,
  );
});
