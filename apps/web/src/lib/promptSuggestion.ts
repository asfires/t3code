import type { OrchestrationV2Run } from "@t3tools/contracts";

export function deriveLatestPromptSuggestion(
  latestRun: Pick<OrchestrationV2Run, "status" | "suggestedPrompt"> | null | undefined,
): string | null {
  if (latestRun?.status !== "completed") return null;
  return latestRun.suggestedPrompt?.trim() || null;
}
