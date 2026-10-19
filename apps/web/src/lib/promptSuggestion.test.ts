import { describe, expect, it } from "vite-plus/test";
import { deriveLatestPromptSuggestion } from "./promptSuggestion";

describe("deriveLatestPromptSuggestion", () => {
  it("returns the suggestion for the latest completed run", () => {
    expect(
      deriveLatestPromptSuggestion({ status: "completed", suggestedPrompt: "  run the tests  " }),
    ).toBe("run the tests");
  });

  it.each([
    "queued",
    "starting",
    "running",
    "waiting",
    "failed",
    "interrupted",
    "cancelled",
  ] as const)("hides suggestions while the latest run is %s", (status) => {
    expect(deriveLatestPromptSuggestion({ status, suggestedPrompt: "run the tests" })).toBeNull();
  });

  it("hides stale suggestions when a newer run has no suggestion", () => {
    expect(deriveLatestPromptSuggestion({ status: "completed" })).toBeNull();
    expect(deriveLatestPromptSuggestion({ status: "completed", suggestedPrompt: "  " })).toBeNull();
    expect(deriveLatestPromptSuggestion(null)).toBeNull();
  });
});
