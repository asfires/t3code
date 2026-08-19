import ForkMigration005 from "./005_RebuildProjectionsFromEvents.ts";

// Re-run fork migration 005's wipe-and-replay. The first rebuild ran through a
// turns projector whose thread.reverted handler kept only checkpointed turns,
// deleting checkpointless turns and stranding their messages outside
// turn-anchored pagination. The projector now shares the revert denylist with
// the other projectors, so replaying the event history again rebuilds those
// turn rows.
export default ForkMigration005;
