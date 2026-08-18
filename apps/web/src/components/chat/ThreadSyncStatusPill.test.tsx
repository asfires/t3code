import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ThreadSyncStatusPill } from "./ThreadSyncStatusPill";

describe("ThreadSyncStatusPill", () => {
  it("renders loading immediately without participating in composer layout", () => {
    const markup = renderToStaticMarkup(<ThreadSyncStatusPill phase="loading" />);

    expect(markup).toContain('role="status"');
    expect(markup).toContain("Loading messages...");
    expect(markup).toContain("absolute");
    expect(markup).toContain("bottom-full");
    expect(markup).not.toContain("animate-");
  });

  it("withholds the cached-thread syncing phase initially", () => {
    const markup = renderToStaticMarkup(<ThreadSyncStatusPill phase="syncing" />);

    expect(markup).toBe("");
  });
});
