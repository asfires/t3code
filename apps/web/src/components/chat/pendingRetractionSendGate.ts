export const PENDING_RETRACTION_SEND_TIMEOUT_MS = 20_000;

interface PendingWaiter {
  resolve: (released: boolean) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

export interface PendingRetractionSendGate {
  wait: () => Promise<boolean>;
  release: () => void;
  dispose: () => void;
}

export function createPendingRetractionSendGate(input?: {
  timeoutMs?: number;
}): PendingRetractionSendGate {
  const timeoutMs = input?.timeoutMs ?? PENDING_RETRACTION_SEND_TIMEOUT_MS;
  const waiters = new Set<PendingWaiter>();

  const settle = (waiter: PendingWaiter, released: boolean) => {
    if (!waiters.delete(waiter)) return;
    clearTimeout(waiter.timeoutId);
    waiter.resolve(released);
  };

  return {
    wait: () =>
      new Promise<boolean>((resolve) => {
        const waiter = {
          resolve,
          timeoutId: setTimeout(() => settle(waiter, false), timeoutMs),
        } satisfies PendingWaiter;
        waiters.add(waiter);
      }),
    release: () => {
      for (const waiter of waiters) settle(waiter, true);
    },
    dispose: () => {
      for (const waiter of waiters) settle(waiter, false);
    },
  };
}
