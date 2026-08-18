import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_turn_retractions (
      request_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      baseline_turn_count INTEGER NOT NULL,
      baseline_checkpoint_ref TEXT NOT NULL,
      target_turn_id TEXT,
      provider_send_claimed INTEGER NOT NULL DEFAULT 0,
      first_user_message INTEGER NOT NULL,
      requested_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('requested', 'completed', 'failed')),
      completed_at TEXT,
      failed_at TEXT
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_turn_retractions_pending_thread
    ON projection_turn_retractions(thread_id)
    WHERE status = 'requested'
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_turn_retractions_status_requested
    ON projection_turn_retractions(status, requested_at, request_id)
  `;
});
