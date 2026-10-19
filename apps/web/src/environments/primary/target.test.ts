import { describe, expect, it } from "vite-plus/test";

import { isLoopbackHostname } from "./target";

describe("isLoopbackHostname", () => {
  it.each([
    "localhost",
    "feature-worktree.localhost",
    "FEATURE-WORKTREE.LOCALHOST",
    "127.0.0.1",
    "::1",
    "[::1]",
  ])("treats %s as loopback", (hostname) => {
    expect(isLoopbackHostname(hostname)).toBe(true);
  });

  it.each(["example.com", "localhost.example.com", "example.local"])(
    "does not treat %s as loopback",
    (hostname) => {
      expect(isLoopbackHostname(hostname)).toBe(false);
    },
  );
});
