import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createPendingRetractionSendGate } from "./pendingRetractionSendGate";

describe("pending retraction send gate", () => {
  afterEach(() => vi.useRealTimers());

  it("releases a held send when retraction completes", async () => {
    const gate = createPendingRetractionSendGate();
    const held = gate.wait();

    gate.release();

    await expect(held).resolves.toBe(true);
  });

  it("times out a held send without dispatching it", async () => {
    vi.useFakeTimers();
    const gate = createPendingRetractionSendGate({ timeoutMs: 20_000 });
    const held = gate.wait();

    await vi.advanceTimersByTimeAsync(20_000);

    await expect(held).resolves.toBe(false);
  });
});
