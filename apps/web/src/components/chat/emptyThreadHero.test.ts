import { describe, expect, it } from "vite-plus/test";

import { shouldRenderEmptyThreadHero } from "./emptyThreadHero";

const idlePersistedThread = {
  routeKind: "server" as const,
  timelineEntryCount: 0,
  isWorking: false,
  phase: "disconnected" as const,
  dockRequested: false,
  threadDetailLoading: false,
};

describe("empty thread hero", () => {
  it("shows the project hero for an empty idle persisted thread", () => {
    expect(shouldRenderEmptyThreadHero(idlePersistedThread)).toBe(true);
    expect(shouldRenderEmptyThreadHero({ ...idlePersistedThread, phase: "ready" })).toBe(true);
  });

  it("keeps the timeline visible once content or work exists", () => {
    expect(shouldRenderEmptyThreadHero({ ...idlePersistedThread, timelineEntryCount: 1 })).toBe(
      false,
    );
    expect(shouldRenderEmptyThreadHero({ ...idlePersistedThread, isWorking: true })).toBe(false);
  });

  it("does not flash the hero while a persisted thread is loading or starting", () => {
    expect(shouldRenderEmptyThreadHero({ ...idlePersistedThread, threadDetailLoading: true })).toBe(
      false,
    );
    expect(shouldRenderEmptyThreadHero({ ...idlePersistedThread, phase: "connecting" })).toBe(
      false,
    );
  });

  it("preserves the existing empty local-draft hero", () => {
    expect(
      shouldRenderEmptyThreadHero({
        ...idlePersistedThread,
        routeKind: "draft",
        phase: "connecting",
      }),
    ).toBe(true);
  });
});
