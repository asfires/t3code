import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN ('projection_thread_messages', 'projection_turn_retractions')
  `;
  const tableNames = new Set(tables.map((table) => table.name));
  if (
    !tableNames.has("projection_thread_messages") ||
    !tableNames.has("projection_turn_retractions")
  ) {
    return;
  }

  yield* sql`
    DELETE FROM projection_thread_messages
    WHERE message_id IN (
      SELECT message_id
      FROM projection_turn_retractions
      WHERE status = 'completed'
    )
  `;
});
