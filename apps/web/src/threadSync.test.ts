import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  resolveThreadSyncPhase,
  scheduleThreadSyncStatusReveal,
  THREAD_SYNC_STATUS_REVEAL_DELAY_MS,
  threadSyncLabel,
} from "./threadSync";

describe("resolveThreadSyncPhase", () => {
  it("loads when only shell data is available", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: false,
        shellExists: true,
        status: "synchronizing",
      }),
    ).toBe("loading");
  });

  it("syncs when cached detail is already visible", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: "cached",
      }),
    ).toBe("syncing");
  });

  it("does not report a sync phase without a shell or after going live", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: false,
        shellExists: false,
        status: "empty",
      }),
    ).toBeNull();
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: "live",
      }),
    ).toBeNull();
  });
});

describe("threadSyncLabel", () => {
  it("uses the same loading and syncing language as mobile", () => {
    expect(threadSyncLabel("loading")).toBe("Loading messages...");
    expect(threadSyncLabel("syncing")).toBe("Syncing messages...");
  });
});

describe("scheduleThreadSyncStatusReveal", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("withholds brief foreground syncs", () => {
    const reveal = vi.fn();
    scheduleThreadSyncStatusReveal(reveal);

    vi.advanceTimersByTime(THREAD_SYNC_STATUS_REVEAL_DELAY_MS - 1);
    expect(reveal).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(reveal).toHaveBeenCalledOnce();
  });

  it("cancels the reveal when synchronization finishes first", () => {
    const reveal = vi.fn();
    const cancel = scheduleThreadSyncStatusReveal(reveal);

    cancel();
    vi.advanceTimersByTime(THREAD_SYNC_STATUS_REVEAL_DELAY_MS);

    expect(reveal).not.toHaveBeenCalled();
  });
});
