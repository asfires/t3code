import type { SessionPhase } from "../../types";

export function shouldRenderEmptyThreadHero(input: {
  routeKind: "draft" | "server";
  timelineEntryCount: number;
  isWorking: boolean;
  phase: SessionPhase;
  dockRequested: boolean;
  threadDetailLoading: boolean;
}): boolean {
  if (
    input.timelineEntryCount > 0 ||
    input.isWorking ||
    input.dockRequested ||
    input.threadDetailLoading
  ) {
    return false;
  }
  if (input.routeKind === "draft") return true;
  return input.phase !== "connecting" && input.phase !== "running";
}
