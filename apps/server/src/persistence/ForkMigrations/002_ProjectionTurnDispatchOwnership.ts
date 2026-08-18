import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_turn_retractions
    ADD COLUMN provider_send_state TEXT NOT NULL DEFAULT 'unclaimed'
      CHECK (provider_send_state IN ('unclaimed', 'claimed', 'cancelled'))
  `;

  yield* sql`
    UPDATE projection_turn_retractions
    SET provider_send_state = 'claimed'
    WHERE provider_send_claimed <> 0
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_turn_send_claims (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, message_id)
    )
  `;
});
