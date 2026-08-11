import type { MessageId } from "@t3tools/contracts";

type PreDispatchSendState =
  | { readonly phase: "idle" }
  | { readonly phase: "pending"; readonly messageId: MessageId }
  | { readonly phase: "cancelled"; readonly messageId: MessageId }
  | { readonly phase: "dispatching"; readonly messageId: MessageId };

export interface PreDispatchCancellationLatch {
  arm: (messageId: MessageId) => void;
  cancel: () => MessageId | null;
  isCancelled: (messageId: MessageId) => boolean;
  beginDispatch: (messageId: MessageId) => boolean;
  clear: (messageId: MessageId) => void;
}

/**
 * Linearizes local Escape cancellation against the turn-start RPC boundary.
 * JavaScript runs both transitions synchronously: whichever of `cancel` or
 * `beginDispatch` wins first owns the send.
 */
export function createPreDispatchCancellationLatch(): PreDispatchCancellationLatch {
  let state: PreDispatchSendState = { phase: "idle" };

  return {
    arm: (messageId) => {
      state = { phase: "pending", messageId };
    },
    cancel: () => {
      if (state.phase !== "pending") return null;
      state = { phase: "cancelled", messageId: state.messageId };
      return state.messageId;
    },
    isCancelled: (messageId) => state.phase === "cancelled" && state.messageId === messageId,
    beginDispatch: (messageId) => {
      if (state.phase !== "pending" || state.messageId !== messageId) {
        return false;
      }
      state = { phase: "dispatching", messageId };
      return true;
    },
    clear: (messageId) => {
      if (state.phase !== "idle" && state.messageId === messageId) {
        state = { phase: "idle" };
      }
    },
  };
}
