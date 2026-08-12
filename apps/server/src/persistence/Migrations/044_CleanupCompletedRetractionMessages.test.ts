import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("044_CleanupCompletedRetractionMessages", (it) => {
  it.effect("removes only messages belonging to completed retractions and is idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        ) VALUES
          (
            'message-completed', 'thread-1', NULL, 'user', 'completed', 0,
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
          ),
          (
            'message-requested', 'thread-1', NULL, 'user', 'requested', 0,
            '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z'
          ),
          (
            'message-unrelated', 'thread-1', 'turn-1', 'assistant', 'unrelated', 0,
            '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z'
          )
      `;
      yield* sql`
        INSERT INTO projection_turn_retractions (
          request_id, thread_id, message_id, baseline_turn_count,
          baseline_checkpoint_ref, target_turn_id, provider_send_claimed,
          first_user_message, requested_at, status, completed_at, failed_at
        ) VALUES
          (
            'request-completed', 'thread-1', 'message-completed', 1,
            'refs/t3/thread/thread-1/turn/1', 'turn-1', 1,
            0, '2026-01-01T00:00:03.000Z', 'completed',
            '2026-01-01T00:00:04.000Z', NULL
          ),
          (
            'request-requested', 'thread-1', 'message-requested', 1,
            'refs/t3/thread/thread-1/turn/1', 'turn-1', 0,
            0, '2026-01-01T00:00:05.000Z', 'requested', NULL, NULL
          )
      `;

      const firstRun = yield* runMigrations({ toMigrationInclusive: 44 });
      assert.deepEqual(firstRun, [[44, "CleanupCompletedRetractionMessages"]]);

      const rowsAfterFirstRun = yield* sql<{ readonly messageId: string }>`
        SELECT message_id AS "messageId"
        FROM projection_thread_messages
        ORDER BY message_id
      `;
      assert.deepEqual(rowsAfterFirstRun, [
        { messageId: "message-requested" },
        { messageId: "message-unrelated" },
      ]);

      const secondRun = yield* runMigrations({ toMigrationInclusive: 44 });
      assert.deepEqual(secondRun, []);

      const rowsAfterSecondRun = yield* sql<{ readonly messageId: string }>`
        SELECT message_id AS "messageId"
        FROM projection_thread_messages
        ORDER BY message_id
      `;
      assert.deepEqual(rowsAfterSecondRun, rowsAfterFirstRun);
    }),
  );
});
