import type { CommandId, MessageId } from "@t3tools/contracts";

export type OptimisticRetractionsByMessageId = Record<string, CommandId>;

export function hideOptimisticallyRetractedMessage(
  existing: OptimisticRetractionsByMessageId,
  input: { requestId: CommandId; messageId: MessageId },
): OptimisticRetractionsByMessageId {
  return { ...existing, [input.messageId]: input.requestId };
}

export function unhideOptimisticallyRetractedMessage(
  existing: OptimisticRetractionsByMessageId,
  input: { requestId: CommandId; messageId: MessageId },
): OptimisticRetractionsByMessageId {
  if (existing[input.messageId] !== input.requestId) return existing;
  const { [input.messageId]: _removed, ...next } = existing;
  return next;
}

/** Executes all visible optimistic work before starting the asynchronous command. */
export function beginOptimisticRetraction<T>(input: {
  restoreComposer: () => void;
  hideMessage: () => void;
  dispatch: () => T;
}): T {
  input.restoreComposer();
  input.hideMessage();
  return input.dispatch();
}
