import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ThreadSyncStatusPill } from "./ThreadSyncStatusPill";

describe("ThreadSyncStatusPill", () => {
  it("renders loading immediately as an attached composer drawer", () => {
    const label = "Loading messages...";
    const markup = renderToStaticMarkup(<ThreadSyncStatusPill phase="loading" />);

    expect(markup).toContain('role="status"');
    expect(markup).toContain('data-thread-sync-drawer="true"');
    expect(markup).toContain("chat-composer-drawer-surface");
    expect(markup).toContain("chat-composer-drawer-attached");
    expect(markup).toContain("chat-composer-drawer-slot");
    expect(markup).toContain("pb-[calc(var(--chat-composer-attachment-overlap)_+_0.375rem)]");
    expect(markup).toContain(label);
    expect(markup).not.toContain("animate-");
  });

  it("withholds the cached-thread syncing phase initially", () => {
    const markup = renderToStaticMarkup(<ThreadSyncStatusPill phase="syncing" />);

    expect(markup).toBe("");
  });
});
