import { LoaderCircleIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { threadSyncLabel, type ThreadSyncPhase } from "../../threadSync";

export function ThreadSyncStatusPill({ phase }: { readonly phase: ThreadSyncPhase }) {
  const [syncingVisible, setSyncingVisible] = useState(phase === "loading");

  useEffect(() => {
    if (phase !== "syncing") return;
    const timeoutId = globalThis.setTimeout(() => setSyncingVisible(true), 300);
    return () => globalThis.clearTimeout(timeoutId);
  }, [phase]);

  if (phase === "syncing" && !syncingVisible) return null;

  const label = threadSyncLabel(phase);

  return (
    <div
      aria-label={label}
      className="chat-composer-drawer-surface chat-composer-drawer-attached chat-composer-drawer-slot pointer-events-none flex items-center gap-2 px-3 pt-2 pb-[calc(var(--chat-composer-attachment-overlap)_+_0.375rem)] text-foreground text-xs font-medium sm:px-4"
      data-thread-sync-drawer="true"
      role="status"
    >
      <LoaderCircleIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate">{label}</span>
    </div>
  );
}
