import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";

export type ThreadSyncPhase = "loading" | "syncing";

export const THREAD_SYNC_STATUS_REVEAL_DELAY_MS = 300;

export function resolveThreadSyncPhase(input: {
  readonly detailExists: boolean;
  readonly shellExists: boolean;
  readonly status: EnvironmentThreadStatus;
}): ThreadSyncPhase | null {
  if (!input.shellExists) {
    return null;
  }

  switch (input.status) {
    case "empty":
    case "cached":
    case "synchronizing":
      return input.detailExists ? "syncing" : "loading";
    case "deleted":
    case "live":
      return null;
  }
}

export function threadSyncLabel(phase: ThreadSyncPhase): string {
  return phase === "loading" ? "Loading messages..." : "Syncing messages...";
}

export function scheduleThreadSyncStatusReveal(reveal: () => void): () => void {
  const timeoutId = globalThis.setTimeout(reveal, THREAD_SYNC_STATUS_REVEAL_DELAY_MS);
  return () => globalThis.clearTimeout(timeoutId);
}
