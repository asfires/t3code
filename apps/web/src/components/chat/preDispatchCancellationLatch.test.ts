import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createPreDispatchCancellationLatch } from "./preDispatchCancellationLatch";

describe("pre-dispatch cancellation latch", () => {
  it("cancels the retained message before dispatch begins", () => {
    const latch = createPreDispatchCancellationLatch();
    const messageId = MessageId.make("message-1");

    latch.arm(messageId);

    expect(latch.cancel()).toBe(messageId);
    expect(latch.isCancelled(messageId)).toBe(true);
    expect(latch.beginDispatch(messageId)).toBe(false);
  });

  it("does nothing when Escape loses the race to an in-flight dispatch", () => {
    const latch = createPreDispatchCancellationLatch();
    const messageId = MessageId.make("message-1");

    latch.arm(messageId);

    expect(latch.beginDispatch(messageId)).toBe(true);
    expect(latch.cancel()).toBeNull();
    expect(latch.isCancelled(messageId)).toBe(false);
  });

  it("does not let a stale message clear or dispatch a newer latch", () => {
    const latch = createPreDispatchCancellationLatch();
    const staleMessageId = MessageId.make("message-stale");
    const currentMessageId = MessageId.make("message-current");

    latch.arm(staleMessageId);
    latch.arm(currentMessageId);
    latch.clear(staleMessageId);

    expect(latch.beginDispatch(staleMessageId)).toBe(false);
    expect(latch.cancel()).toBe(currentMessageId);
  });
});
