import { describe, expect, it } from "vite-plus/test";

import { INITIAL_SERVER_BOOT_RELOAD_STATE, observeServerBoot } from "./serverBootReload";

function observeAll(bootIdentities: ReadonlyArray<string>) {
  let state = INITIAL_SERVER_BOOT_RELOAD_STATE;
  let reloads = 0;
  for (const bootIdentity of bootIdentities) {
    const transition = observeServerBoot(state, bootIdentity);
    state = transition.state;
    if (transition.shouldReload) reloads += 1;
  }
  return reloads;
}

describe("observeServerBoot", () => {
  it("does not reload when reconnecting to the same server boot", () => {
    expect(observeAll(["boot-a", "boot-a"])).toBe(0);
  });

  it("reloads exactly once when the server boot changes", () => {
    expect(observeAll(["boot-a", "boot-b"])).toBe(1);
  });

  it("accepts the new boot after a page reload and detects the next restart", () => {
    expect(observeAll(["boot-a", "boot-b"])).toBe(1);
    expect(observeAll(["boot-b", "boot-b"])).toBe(0);
    expect(observeAll(["boot-b", "boot-c"])).toBe(1);
  });

  it("does not loop when either boot identity is delivered repeatedly", () => {
    expect(observeAll(["boot-a", "boot-a", "boot-b", "boot-b", "boot-a"])).toBe(1);
  });
});
