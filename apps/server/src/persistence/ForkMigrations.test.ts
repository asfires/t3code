import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import {
  forkMigrationManifest,
  forkMigrationsTable,
  runAllMigrations,
  runForkMigrations,
} from "./ForkMigrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const freshLayer = () => it.layer(Layer.fresh(Layer.mergeAll(NodeSqliteClient.layerMemory())));

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

freshLayer()("ForkMigrations with ids 1 through 6 already recorded", (it) => {
  it.effect("advances to 7 while preserving managed worktrees and existing ledger rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* runForkMigrations({ toMigrationInclusive: 3 });
      for (const id of [1, 2, 4, 5, 6]) {
        yield* sql`INSERT INTO effect_sql_migrations_fork (migration_id, name) VALUES (${id}, ${`RetiredMigration${id}`})`;
      }
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, created_at, updated_at, managed_worktree_json)
        VALUES ('thread', 'project', 'Kept', '2026-09-18', '2026-09-18', '{"path":"/tmp/kept"}')`;
      const before = yield* readLedger(forkMigrationsTable);
      const result = yield* runAllMigrations();
      assert.deepEqual(result.upstream, []);
      assert.deepEqual(
        result.fork.map(([id]) => id),
        [7],
      );
      assert.deepEqual(yield* readIds(forkMigrationsTable), [1, 2, 3, 4, 5, 6, 7]);
      assert.deepEqual((yield* readLedger(forkMigrationsTable)).slice(0, 6), before);
      assert.deepEqual(yield* sql`SELECT managed_worktree_json FROM projection_threads`, [
        { managed_worktree_json: '{"path":"/tmp/kept"}' },
      ]);
      assert.deepEqual(yield* runAllMigrations(), { upstream: [], fork: [] });
    }),
  );
});

freshLayer()("ForkMigrations after the previous upstream sync", (it) => {
  it.effect("adds upstream schema without re-running fork projection rebuilds", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* runForkMigrations();
      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES ('projection.threads', 42, '2026-09-18T00:00:00.000Z')
      `;
      const result = yield* runAllMigrations();
      assert.deepEqual(result, {
        upstream: migrationManifest.filter(([id]) => id > 52),
        fork: [],
      });
      const state = yield* sql<{ readonly sequence: number }>`
        SELECT last_applied_sequence AS sequence FROM projection_state
        WHERE projector = 'projection.threads'
      `;
      assert.deepEqual(state, [{ sequence: 42 }]);
      const viewedFiles = yield* sql`SELECT * FROM pull_request_files_viewed`;
      assert.deepEqual(viewedFiles, []);
    }),
  );
});
