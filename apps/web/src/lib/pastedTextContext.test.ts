import { describe, expect, it } from "vite-plus/test";

import {
  formatPastedTextLabel,
  formatPastedTextStats,
  parsePastedTextOrdinals,
  pastedTextOrdinals,
  pastedTextSummary,
  serializePastedTextOrdinals,
} from "./pastedTextContext";

describe("pastedTextOrdinals", () => {
  it("numbers pasted-text chips by their position in the prompt", () => {
    const prompt =
      "Compare [Pasted text](t3-context://v1/pasted-text/pasted-text_b) with " +
      "[Terminal](t3-context://v1/terminal/terminal_x) and " +
      "[Pasted text](t3-context://v1/pasted-text/pasted-text_a), then " +
      "[Pasted text](t3-context://v1/pasted-text/pasted-text_b) again.";
    const ordinals = pastedTextOrdinals(prompt);
    expect([...ordinals.entries()]).toEqual([
      ["pasted-text_b", 1],
      ["pasted-text_a", 2],
    ]);
    expect(formatPastedTextLabel(ordinals.get("pasted-text_a"))).toBe("Pasted text #2");
    expect(formatPastedTextLabel(undefined)).toBe("Pasted text");
  });

  it("round-trips through the serialized key", () => {
    const ordinals = new Map([
      ["pasted-text_b", 1],
      ["pasted-text_a", 2],
    ]);
    const key = serializePastedTextOrdinals(ordinals);
    expect(key).toBe("pasted-text_b:1,pasted-text_a:2");
    expect([...parsePastedTextOrdinals(key)]).toEqual([...ordinals]);
    expect(parsePastedTextOrdinals("").size).toBe(0);
  });
});

describe("pastedTextSummary", () => {
  it("uses the first non-empty line and truncates long ones", () => {
    expect(pastedTextSummary("\n\n  error: boom  \nmore")).toBe("error: boom");
    expect(pastedTextSummary(`${"x".repeat(100)}\ny`)).toBe(`${"x".repeat(79)}…`);
  });
});

describe("formatPastedTextStats", () => {
  it("counts lines and characters", () => {
    expect(formatPastedTextStats("a\nb\nc")).toBe("3 lines · 5 characters");
    expect(formatPastedTextStats("a")).toBe("1 line · 1 character");
  });
});
