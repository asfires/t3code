interface RevertTurnEvidence {
  readonly turnId: string | null;
  readonly checkpointTurnCount: number | null;
}

/**
 * Checkpoints prove which turns cross the baseline. The retraction target is
 * authoritative; latest/session ids cover current work that has no checkpoint.
 */
export function collectRevertedTurnIds(input: {
  readonly turns: ReadonlyArray<RevertTurnEvidence>;
  readonly baselineTurnCount: number;
  readonly retractionTurnId: string | null;
  readonly latestTurnId: string | null;
  readonly activeTurnId: string | null;
}): ReadonlySet<string> {
  const revertedTurnIds = new Set<string>();
  const retainedCheckpointTurnIds = new Set<string>();

  for (const turn of input.turns) {
    if (turn.turnId === null || turn.checkpointTurnCount === null) {
      continue;
    }
    if (turn.checkpointTurnCount > input.baselineTurnCount) {
      revertedTurnIds.add(turn.turnId);
    } else {
      retainedCheckpointTurnIds.add(turn.turnId);
    }
  }

  if (input.retractionTurnId !== null) {
    revertedTurnIds.add(input.retractionTurnId);
  }

  for (const fallbackTurnId of [input.latestTurnId, input.activeTurnId]) {
    if (fallbackTurnId !== null && !retainedCheckpointTurnIds.has(fallbackTurnId)) {
      revertedTurnIds.add(fallbackTurnId);
    }
  }

  return revertedTurnIds;
}
