import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationManifest, runMigrations } from "../Migrations.ts";
import rebuildProjectionsFromEvents, {
  projectionTableNames,
} from "./045_RebuildProjectionsFromEvents.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("045_RebuildProjectionsFromEvents", (it) => {
  it.effect("clears every event-derived projection and resets cursors idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      for (const tableName of projectionTableNames) {
        yield* sql.unsafe(`CREATE TABLE ${tableName} (value TEXT NOT NULL)`).unprepared;
        yield* sql.unsafe(`INSERT INTO ${tableName} (value) VALUES ('projected')`).unprepared;
      }
      yield* sql`
        CREATE TABLE projection_state (
          projector TEXT PRIMARY KEY,
          last_applied_sequence INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES ('projection.threads', 42, '2026-01-01T00:00:00.000Z')
      `;

      yield* rebuildProjectionsFromEvents;
      yield* rebuildProjectionsFromEvents;

      for (const tableName of projectionTableNames) {
        const rows = yield* sql.unsafe<{ readonly count: number }>(
          `SELECT COUNT(*) AS count FROM ${tableName}`,
        ).unprepared;
        assert.equal(rows[0]?.count, 0);
      }
      const stateRows = yield* sql<{
        readonly projector: string;
        readonly lastAppliedSequence: number;
      }>`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence"
        FROM projection_state
      `;
      assert.deepEqual(stateRows, [{ projector: "projection.threads", lastAppliedSequence: 0 }]);

      yield* sql`DROP TABLE projection_thread_proposed_plans`;
      yield* rebuildProjectionsFromEvents;
      assert.deepEqual(migrationManifest.at(-1), [45, "RebuildProjectionsFromEvents"]);
    }),
  );
});

it.layer(Layer.fresh(Layer.mergeAll(NodeSqliteClient.layerMemory())))(
  "045_RebuildProjectionsFromEvents registration",
  (it) => {
    it.effect("runs after migration 044 against the full projection schema", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* runMigrations({ toMigrationInclusive: 44 });
        yield* sql`
          INSERT INTO projection_thread_messages (
            message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
          ) VALUES (
            'message-before-rebuild', 'thread-before-rebuild', NULL, 'user', 'stale', 0,
            '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
          )
        `;
        yield* sql`
          INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
          VALUES ('projection.thread-messages', 99, '2026-01-01T00:00:00.000Z')
        `;

        const migrations = yield* runMigrations({ toMigrationInclusive: 45 });
        assert.deepEqual(migrations, [[45, "RebuildProjectionsFromEvents"]]);

        const messageRows = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM projection_thread_messages
        `;
        assert.equal(messageRows[0]?.count, 0);
        const stateRows = yield* sql<{ readonly lastAppliedSequence: number }>`
          SELECT last_applied_sequence AS "lastAppliedSequence"
          FROM projection_state
        `;
        assert.deepEqual(stateRows, [{ lastAppliedSequence: 0 }]);
      }),
    );
  },
);
