import { isOrchestrationV2WorkActive, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import { turnItemOutputText } from "@t3tools/client-runtime/work-log/item-detail";

export function toolRowCopyTargets(item: OrchestrationV2TurnItem) {
  const command = item.type === "command_execution" ? item.input.trim() : null;
  const output =
    Boolean(turnItemOutputText(item)?.trim()) ||
    ((item.type === "command_execution" || item.type === "dynamic_tool") &&
      (item.outputOmitted === true || isOrchestrationV2WorkActive(item.status)));
  return { command, output };
}

export async function loadToolRowCopyOutput(
  fetchDetail: () => Promise<OrchestrationV2TurnItem | null>,
  fetchStream?: () => Promise<{ readonly text: string; readonly truncated: boolean }>,
): Promise<string> {
  const item = await fetchDetail();
  if (item === null) throw new Error("Output is no longer available.");
  const output = turnItemOutputText(item);
  if (output?.trim()) return output;
  // Some providers persist output only at completion. Never pass off a live tail as full output.
  if (item.type === "command_execution" && fetchStream) {
    const stream = await fetchStream();
    if (stream.truncated) {
      throw new Error("Full output is not available yet. Try again when the command finishes.");
    }
    if (stream.text.trim()) return stream.text;
  }
  throw new Error("No output available to copy.");
}
