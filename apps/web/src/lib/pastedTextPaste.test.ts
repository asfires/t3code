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
    expect(planPastedText({ ...base, draft: draft("new", "x".repeat(119_900)) })).toEqual({
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
    ).toEqual({ disposition: "record", wouldExceedInputLimit: false });
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
