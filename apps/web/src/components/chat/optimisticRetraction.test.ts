import { CommandId, MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  beginOptimisticRetraction,
  hideOptimisticallyRetractedMessage,
  unhideOptimisticallyRetractedMessage,
} from "./optimisticRetraction";

describe("optimistic turn retraction", () => {
  it("restores and hides synchronously before dispatch resolves", async () => {
    const order: string[] = [];
    let resolveDispatch: (() => void) | undefined;
    const dispatched = new Promise<void>((resolve) => {
      resolveDispatch = resolve;
    });

    const result = beginOptimisticRetraction({
      restoreComposer: () => order.push("restore"),
      hideMessage: () => order.push("hide"),
      dispatch: () => {
        order.push("dispatch");
        return dispatched;
      },
    });

    expect(order).toEqual(["restore", "hide", "dispatch"]);
    resolveDispatch?.();
    await result;
  });

  it("only unhides the row for the correlated rejected request", () => {
    const messageId = MessageId.make("message-1");
    const requestId = CommandId.make("request-1");
    const hidden = hideOptimisticallyRetractedMessage({}, { messageId, requestId });

    expect(
      unhideOptimisticallyRetractedMessage(hidden, {
        messageId,
        requestId: CommandId.make("request-2"),
      }),
    ).toBe(hidden);
    expect(unhideOptimisticallyRetractedMessage(hidden, { messageId, requestId })).toEqual({});
  });
});
