import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const projectionTableNames = [
  "projection_projects",
  "projection_threads",
  "projection_thread_messages",
  "projection_thread_activities",
  "projection_thread_sessions",
  "projection_turns",
  "projection_pending_approvals",
  "projection_thread_proposed_plans",
  "projection_turn_retractions",
] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
  `;
  const tableNames = new Set(tables.map((table) => table.name));

  if (tableNames.has("projection_projects")) {
    yield* sql`DELETE FROM projection_projects`;
  }
  if (tableNames.has("projection_threads")) {
    yield* sql`DELETE FROM projection_threads`;
  }
  if (tableNames.has("projection_thread_messages")) {
    yield* sql`DELETE FROM projection_thread_messages`;
  }
  if (tableNames.has("projection_thread_activities")) {
    yield* sql`DELETE FROM projection_thread_activities`;
  }
  if (tableNames.has("projection_thread_sessions")) {
    yield* sql`DELETE FROM projection_thread_sessions`;
  }
  if (tableNames.has("projection_turns")) {
    yield* sql`DELETE FROM projection_turns`;
  }
  if (tableNames.has("projection_pending_approvals")) {
    yield* sql`DELETE FROM projection_pending_approvals`;
  }
  if (tableNames.has("projection_thread_proposed_plans")) {
    yield* sql`DELETE FROM projection_thread_proposed_plans`;
  }
  if (tableNames.has("projection_turn_retractions")) {
    yield* sql`DELETE FROM projection_turn_retractions`;
  }
  if (tableNames.has("projection_state")) {
    yield* sql`UPDATE projection_state SET last_applied_sequence = 0`;
  }
});

export { projectionTableNames };
