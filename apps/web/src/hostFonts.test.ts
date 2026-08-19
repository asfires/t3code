import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { canUseHostFontEnumeration } from "./hostFonts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("canUseHostFontEnumeration", () => {
  it.each(["localhost", "feature-worktree.localhost", "FEATURE-WORKTREE.LOCALHOST"])(
    "allows host font enumeration at %s",
    (hostname) => {
      vi.stubGlobal("window", { desktopBridge: undefined, location: { hostname } });

      expect(canUseHostFontEnumeration()).toBe(true);
    },
  );

  it("does not enumerate host fonts for a remote browser", () => {
    vi.stubGlobal("window", {
      desktopBridge: undefined,
      location: { hostname: "example.com" },
    });

    expect(canUseHostFontEnumeration()).toBe(false);
  });
});
