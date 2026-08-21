import { describe, expect, it } from "vite-plus/test";

import {
  materializePastedText,
  serializePastedText,
  shouldPresentPasteAsBlock,
  splitPastedTextSegments,
  summarizePastedText,
} from "./pastedText.js";

describe("pasted text presentation", () => {
  it("round-trips exact pasted text without exposing the presentation envelope", () => {
    const pasted = "  first line\nsecond:\uE001 line\n";
    const value = `before ${serializePastedText(pasted)} after`;

    expect(materializePastedText(value)).toBe(`before ${pasted} after`);
    expect(splitPastedTextSegments(value)).toEqual([
      { type: "text", text: "before " },
      { type: "pasted-text", text: pasted, source: serializePastedText(pasted) },
      { type: "text", text: " after" },
    ]);
  });

  it("numbers pasted blocks from their current order", () => {
    const first = serializePastedText("first");
    const second = serializePastedText("second");

    expect(summarizePastedText(`${first} / ${second}`)).toBe("Pasted text #1 / Pasted text #2");
    expect(summarizePastedText(second)).toBe("Pasted text #1");
  });

  it("leaves malformed envelopes as ordinary text", () => {
    const malformed = "before \uE000t3-pasted-text:12:short\uE001 after";
    expect(materializePastedText(malformed)).toBe(malformed);
  });

  it("recognizes long or multiline paste blocks without collapsing ordinary snippets", () => {
    expect(shouldPresentPasteAsBlock("x".repeat(999))).toBe(false);
    expect(shouldPresentPasteAsBlock("x".repeat(1_000))).toBe(true);
    expect(shouldPresentPasteAsBlock(Array.from({ length: 20 }, () => "x").join("\n"))).toBe(true);
  });
});
