import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import {
  forkMigrationEntries,
  forkMigrationManifest,
  forkMigrationsTable,
  runAllMigrations,
} from "./ForkMigrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";

const freshLayer = () => it.layer(Layer.fresh(Layer.mergeAll(NodeSqliteClient.layerMemory())));

const upstreamLatestId = migrationManifest.at(-1)![0];
const legacyForkRow = (id: number) => 40 + id;

const readLedger = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ readonly id: number; readonly name: string; readonly createdAt: string }>`
      SELECT migration_id AS id, name, created_at AS "createdAt"
      FROM ${sql(table)}
      ORDER BY migration_id ASC
    `;
  });

const readIds = (table: string) =>
  Effect.map(readLedger(table), (rows) => rows.map((row) => row.id));

// Reproduces a database from before the split: fork migrations applied
// through upstream's ledger as 041..046.
const applyLegacyForkMigrations = Effect.gen(function* () {
  yield* runMigrations();
  const legacyLoader = Migrator.fromRecord(
    Object.fromEntries(
      forkMigrationEntries.map(([id, name, migration]) => [
        `${legacyForkRow(id)}_${name}`,
        migration,
      ]),
    ),
  );
  yield* Migrator.make({})({ loader: legacyLoader });
});

freshLayer()("ForkMigrations on a fresh database", (it) => {
  it.effect("runs upstream migrations in their ledger and fork migrations in the fork ledger", () =>
    Effect.gen(function* () {
      const result = yield* runAllMigrations();

      assert.deepEqual(
        result.upstream.map(([id]) => id),
        migrationManifest.map(([id]) => id),
      );
      assert.deepEqual(result.fork, forkMigrationManifest);
      assert.deepEqual(
        yield* readIds("effect_sql_migrations"),
        migrationManifest.map(([id]) => id),
      );
      assert.deepEqual(
        yield* readIds(forkMigrationsTable),
        forkMigrationManifest.map(([id]) => id),
      );

      const again = yield* runAllMigrations();
      assert.deepEqual(again, { upstream: [], fork: [] });
    }),
  );
});

freshLayer()("ForkMigrations on a database migrated before the split", (it) => {
  it.effect("moves fork rows out of the upstream ledger without re-running them", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* applyLegacyForkMigrations;
      yield* sql`
        UPDATE effect_sql_migrations
        SET created_at = '2026-08-12 03:04:05'
        WHERE migration_id > ${upstreamLatestId}
      `;
      // A projection row that a re-run of the rebuild migrations would wipe.
      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES ('projection.threads', 27427, '2026-08-12T03:04:05.000Z')
      `;

      const result = yield* runAllMigrations();

      assert.deepEqual(result, { upstream: [], fork: [] });
      assert.deepEqual(
        yield* readIds("effect_sql_migrations"),
        migrationManifest.map(([id]) => id),
      );
      assert.deepEqual(
        yield* readLedger(forkMigrationsTable),
        forkMigrationManifest.map(([id, name]) => ({
          id,
          name,
          createdAt: "2026-08-12 03:04:05",
        })),
      );
      const stateRows = yield* sql<{ readonly lastAppliedSequence: number }>`
        SELECT last_applied_sequence AS "lastAppliedSequence" FROM projection_state
      `;
      assert.deepEqual(stateRows, [{ lastAppliedSequence: 27427 }]);
    }),
  );
});

freshLayer()(
  "ForkMigrations next to an upstream migration that reuses a legacy fork number",
  (it) => {
    it.effect("adopts only rows whose name matches a fork migration", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* applyLegacyForkMigrations;
        const takenId = legacyForkRow(forkMigrationEntries.length);
        yield* sql`
        UPDATE effect_sql_migrations SET name = 'OrchestrationV2' WHERE migration_id = ${takenId}
      `;

        const result = yield* runAllMigrations();

        // The renamed row stays put and, since it is above the fork's legacy
        // range, the fork migration it displaced re-runs under its own ledger.
        assert.deepEqual(
          result.fork.map(([id]) => id),
          [forkMigrationEntries.length],
        );
        assert.deepEqual(yield* readIds("effect_sql_migrations"), [
          ...migrationManifest.map(([id]) => id),
          takenId,
        ]);
        assert.deepEqual(
          yield* readIds(forkMigrationsTable),
          forkMigrationManifest.map(([id]) => id),
        );
      }),
    );
  },
);
