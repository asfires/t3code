import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("042_ProjectionTurnDispatchOwnership", (it) => {
  it.effect("adds durable provider-send ownership and claim storage", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 41 });
      yield* sql`
        INSERT INTO projection_turn_retractions (
          request_id, thread_id, message_id, baseline_turn_count,
          baseline_checkpoint_ref, target_turn_id, provider_send_claimed,
          first_user_message, requested_at, status, completed_at, failed_at
        ) VALUES (
          'request-claimed', 'thread-1', 'message-1', 0,
          'refs/t3/thread/thread-1/turn/0', NULL, 1,
          1, '2026-01-01T00:00:00.000Z', 'requested', NULL, NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 42 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_turn_retractions)
      `;
      assert.equal(columns.at(-1)?.name, "provider_send_state");

      const rows = yield* sql<{ readonly providerSendState: string }>`
        SELECT provider_send_state AS "providerSendState"
        FROM projection_turn_retractions
        WHERE request_id = 'request-claimed'
      `;
      assert.deepEqual(rows, [{ providerSendState: "claimed" }]);

      const claimTables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'provider_turn_send_claims'
      `;
      assert.equal(claimTables.length, 1);
    }),
  );
});
