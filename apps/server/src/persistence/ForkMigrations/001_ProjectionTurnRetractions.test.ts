import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import { runForkMigrations } from "../ForkMigrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("fork/001_ProjectionTurnRetractions", (it) => {
  it.effect("upgrades an existing schema with durable, startup-indexed retraction rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();
      const existingTables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projection_threads'
      `;
      assert.equal(existingTables.length, 1);

      yield* runForkMigrations({ toMigrationInclusive: 1 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_turn_retractions)
      `;
      assert.deepEqual(
        columns.map((column) => column.name),
        [
          "request_id",
          "thread_id",
          "message_id",
          "baseline_turn_count",
          "baseline_checkpoint_ref",
          "target_turn_id",
          "provider_send_claimed",
          "first_user_message",
          "requested_at",
          "status",
          "completed_at",
          "failed_at",
        ],
      );

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'projection_turn_retractions'
      `;
      const names = new Set(indexes.map((index) => index.name));
      assert.ok(names.has("idx_projection_turn_retractions_pending_thread"));
      assert.ok(names.has("idx_projection_turn_retractions_status_requested"));
    }),
  );
});
