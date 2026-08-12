import { EventId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveLatestPromptSuggestion } from "./promptSuggestion";

function suggestionActivity(turnId: string, suggestedPrompt: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make(`suggestion-${turnId}`),
    tone: "info",
    kind: "prompt-suggestion.updated",
    summary: "Prompt suggestion updated",
    payload: { suggestedPrompt },
    turnId: TurnId.make(turnId),
    createdAt: "2026-08-11T00:00:00.000Z",
  };
}

describe("deriveLatestPromptSuggestion", () => {
  it("returns the suggestion for the latest completed turn", () => {
    expect(
      deriveLatestPromptSuggestion([suggestionActivity("turn-1", "  run the tests  ")], {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: "2026-08-11T00:00:00.000Z",
        startedAt: "2026-08-11T00:00:00.000Z",
        completedAt: "2026-08-11T00:00:01.000Z",
        assistantMessageId: null,
      }),
    ).toBe("run the tests");
  });

  it("hides stale suggestions while a newer turn runs", () => {
    expect(
      deriveLatestPromptSuggestion([suggestionActivity("turn-1", "run the tests")], {
        turnId: TurnId.make("turn-2"),
        state: "running",
        requestedAt: "2026-08-11T00:00:02.000Z",
        startedAt: "2026-08-11T00:00:02.000Z",
        completedAt: null,
        assistantMessageId: null,
      }),
    ).toBeNull();
  });
});
