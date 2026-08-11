import type {
  CommandId,
  OrchestrationThreadTurnRetraction,
  ScopedThreadRef,
  TurnId,
} from "@t3tools/contracts";

import type { SessionPhase } from "../../types";
import {
  type PendingRetractionRecovery,
  useRetractionRecoveryStore,
} from "./lastUserMessageRecovery";

/**
 * Esc pops the just-sent message back into the composer instantly, but the
 * server takes a beat (~1-2s on Claude) to actually retract the turn. Nothing
 * about that settling belongs on screen: the user's mental model is that the
 * turn never started, so the timeline working row, the composer stop button
 * and the sidebar Working badge all have to keep quiet until it lands.
 *
 * Every surface derives that from this one predicate so they cannot disagree,
 * and suppression lives exactly as long as the pending recovery entry does —
 * completion, failure and the 60s staleness path all forget the entry, so a
 * stuck retraction can never masquerade as an idle thread forever.
 */
export interface RetractedTurnProjection {
  requestId: CommandId;
  targetTurnId: TurnId | null;
  status: OrchestrationThreadTurnRetraction["status"];
}

export function findPendingRetractionForThread(
  byRequestId: Record<string, PendingRetractionRecovery>,
  threadRef: ScopedThreadRef | null,
): PendingRetractionRecovery | null {
  if (!threadRef) return null;
  return (
    Object.values(byRequestId).find(
      (recovery) =>
        recovery.sourceThreadRef.environmentId === threadRef.environmentId &&
        recovery.sourceThreadRef.threadId === threadRef.threadId,
    ) ?? null
  );
}

/**
 * Selects the recovery record itself, never a derived array: a selector that
 * builds a fresh reference every snapshot re-renders forever (this store is
 * read from a layout-mounted component).
 */
export function usePendingRetractionForThread(
  threadRef: ScopedThreadRef | null,
): PendingRetractionRecovery | null {
  return useRetractionRecoveryStore((state) =>
    findPendingRetractionForThread(state.byRequestId, threadRef),
  );
}

export function isRetractedTurnPresentationSuppressed(input: {
  pendingRetraction: Pick<PendingRetractionRecovery, "requestId"> | null;
  /** The server's projection of our retraction, once it has caught up. */
  projectedRetraction?: RetractedTurnProjection | null;
  activeTurnId?: TurnId | null;
}): boolean {
  const pending = input.pendingRetraction;
  if (!pending) return false;

  const projected = input.projectedRetraction ?? null;
  // Not acknowledged yet (or a different request): the optimistic pop is all
  // we have, and it is the window this exists for.
  if (projected === null || projected.requestId !== pending.requestId) return true;

  // The retraction terminally failed. The turn really is running, so the true
  // presentation has to come back alongside the failure surfacing.
  if (projected.status === "failed") return false;

  // A different turn is running than the one we retracted — a held send that
  // dispatched, say. New work renders normally.
  const activeTurnId = input.activeTurnId ?? null;
  if (projected.targetTurnId !== null && activeTurnId !== null) {
    return activeTurnId === projected.targetTurnId;
  }
  return true;
}

export function useRetractedTurnPresentationSuppressed(input: {
  threadRef: ScopedThreadRef | null;
  projectedRetraction?: RetractedTurnProjection | null;
  activeTurnId?: TurnId | null;
}): boolean {
  const pendingRetraction = usePendingRetractionForThread(input.threadRef);
  return isRetractedTurnPresentationSuppressed({
    pendingRetraction,
    projectedRetraction: input.projectedRetraction ?? null,
    activeTurnId: input.activeTurnId ?? null,
  });
}

/** Presentation-only phase: the retracted turn reads as settled, never live. */
export function suppressRetractedTurnPhase(phase: SessionPhase, suppressed: boolean): SessionPhase {
  if (!suppressed) return phase;
  return phase === "running" || phase === "connecting" ? "ready" : phase;
}

export interface EffectiveSessionPresentation {
  /** True while a client-known retraction is hiding the turn it retracted. */
  retractedTurnSuppressed: boolean;
  /** Phase for the composer and the timeline. Raw phase still drives the pop
      window, the revert guard and local dispatch bookkeeping. */
  phase: SessionPhase;
  /** Drives the timeline "Working…" row and the send-vs-stop affordance. */
  isWorking: boolean;
  /** Work rows read as settled again while the retracted turn is hidden. */
  activeTurnInProgress: boolean;
}

/**
 * The single presentation derivation the thread view, the working row and the
 * composer all read, so they cannot disagree about whether a thread is busy.
 */
export function deriveEffectiveSessionPresentation(input: {
  phase: SessionPhase;
  pendingRetraction: Pick<PendingRetractionRecovery, "requestId"> | null;
  projectedRetraction?: RetractedTurnProjection | null;
  activeTurnId?: TurnId | null;
  retractionPending: boolean;
  latestTurnSettled: boolean;
  isSendBusy: boolean;
  heldSendPending: boolean;
  isConnecting: boolean;
  isRevertingCheckpoint: boolean;
}): EffectiveSessionPresentation {
  const retractedTurnSuppressed = isRetractedTurnPresentationSuppressed({
    pendingRetraction: input.pendingRetraction,
    projectedRetraction: input.projectedRetraction ?? null,
    activeTurnId: input.activeTurnId ?? null,
  });
  const phase = suppressRetractedTurnPhase(input.phase, retractedTurnSuppressed);
  // heldSendPending stays outside the suppression: the user pressed send, so
  // "sending" reports their own action, not the retraction settling.
  const isWorking =
    phase === "running" ||
    input.isSendBusy ||
    input.heldSendPending ||
    input.isConnecting ||
    input.isRevertingCheckpoint ||
    (input.retractionPending && !retractedTurnSuppressed);
  return {
    retractedTurnSuppressed,
    phase,
    isWorking,
    activeTurnInProgress: isWorking || (!input.latestTurnSettled && !retractedTurnSuppressed),
  };
}
