import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // SQLite drops each table's indexes with the table.
  yield* sql`DROP TABLE IF EXISTS projection_turn_retractions`;
  yield* sql`DROP TABLE IF EXISTS provider_turn_send_claims`;
});
