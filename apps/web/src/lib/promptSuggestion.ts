import type { OrchestrationLatestTurn, OrchestrationThreadActivity } from "@t3tools/contracts";

export function deriveLatestPromptSuggestion(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurn: OrchestrationLatestTurn | null | undefined,
): string | null {
  if (!latestTurn || latestTurn.state !== "completed") {
    return null;
  }

  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (
      !activity ||
      activity.kind !== "prompt-suggestion.updated" ||
      activity.turnId !== latestTurn.turnId
    ) {
      continue;
    }
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const suggestion = payload?.suggestedPrompt;
    if (typeof suggestion === "string" && suggestion.trim().length > 0) {
      return suggestion.trim();
    }
  }

  return null;
}
