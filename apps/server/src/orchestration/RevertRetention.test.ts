import { describe, expect, it } from "vite-plus/test";

import { collectRevertedTurnIds } from "./RevertRetention.ts";

describe("collectRevertedTurnIds", () => {
  it("uses post-baseline checkpoints and uncheckpointed head evidence", () => {
    const revertedTurnIds = collectRevertedTurnIds({
      turns: [
        { turnId: "turn-retained", checkpointTurnCount: 2 },
        { turnId: "turn-after-baseline", checkpointTurnCount: 3 },
        { turnId: "turn-checkpointless-older", checkpointTurnCount: null },
      ],
      baselineTurnCount: 2,
      latestTurnId: "turn-latest-uncheckpointed",
      activeTurnId: "turn-active-uncheckpointed",
    });

    expect([...revertedTurnIds].toSorted()).toEqual([
      "turn-active-uncheckpointed",
      "turn-after-baseline",
      "turn-latest-uncheckpointed",
    ]);
  });

  it("does not treat a latest or active turn with a retained checkpoint as reverted", () => {
    const revertedTurnIds = collectRevertedTurnIds({
      turns: [{ turnId: "turn-retained", checkpointTurnCount: 2 }],
      baselineTurnCount: 2,
      latestTurnId: "turn-retained",
      activeTurnId: "turn-retained",
    });

    expect([...revertedTurnIds]).toEqual([]);
  });
});
