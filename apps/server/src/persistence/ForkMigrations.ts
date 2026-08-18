/**
 * Fork-only migrations, kept out of upstream's ledger.
 *
 * The Effect Migrator is a high-water mark: it runs every loaded migration
 * whose ID is above the largest ID already recorded in its table. Numbering
 * fork migrations after upstream's (041, 042, ...) therefore breaks the next
 * upstream sync in one of two ways: upstream's own 041 is skipped as already
 * applied, or a renumbered fork migration crashes on tables that do not exist.
 * Parking them in a high range is worse still, since the mark then sits above
 * every future upstream migration.
 *
 * So fork migrations get their own ID space (1, 2, ...) and their own ledger
 * table, run through a second Migrator after upstream's. `Migrations.ts` stays
 * byte-identical to upstream and upstream can keep numbering from 041.
 */

import * as Migrator from "effect/unstable/sql/Migrator";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "./Migrations.ts";
import ForkMigration001 from "./ForkMigrations/001_ProjectionTurnRetractions.ts";
import ForkMigration002 from "./ForkMigrations/002_ProjectionTurnDispatchOwnership.ts";
import ForkMigration003 from "./ForkMigrations/003_ProjectionManagedWorktrees.ts";
import ForkMigration004 from "./ForkMigrations/004_CleanupCompletedRetractionMessages.ts";
import ForkMigration005 from "./ForkMigrations/005_RebuildProjectionsFromEvents.ts";
import ForkMigration006 from "./ForkMigrations/006_RebuildProjectionsWithRetainedTurns.ts";

export const forkMigrationsTable = "effect_sql_migrations_fork";
const upstreamMigrationsTable = "effect_sql_migrations";

export const forkMigrationEntries = [
  [1, "ProjectionTurnRetractions", ForkMigration001],
  [2, "ProjectionTurnDispatchOwnership", ForkMigration002],
  [3, "ProjectionManagedWorktrees", ForkMigration003],
  [4, "CleanupCompletedRetractionMessages", ForkMigration004],
  [5, "RebuildProjectionsFromEvents", ForkMigration005],
  [6, "RebuildProjectionsWithRetainedTurns", ForkMigration006],
] as const;

export const forkMigrationManifest = forkMigrationEntries.map(([id, name]) => [id, name] as const);

/**
 * Before the split, fork migrations 1..6 shipped as 041..046 in the upstream
 * ledger. Databases that applied them there carry those rows, so the first
 * boot on this code moves them into the fork ledger under their fork IDs.
 * Rows are matched by ID and name, so an upstream migration that later takes
 * one of those numbers is left alone.
 */
const legacyUpstreamIdOffset = 40;

const makeForkMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      forkMigrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

const run = Migrator.make({});

const adoptLegacyForkLedgerRows = Effect.fn("adoptLegacyForkLedgerRows")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const upstreamLedger = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${upstreamMigrationsTable}
  `;
  if (upstreamLedger.length === 0) {
    return;
  }
  // Same shape the Migrator creates for sqlite, so it adopts the table as-is.
  yield* sql`
    CREATE TABLE IF NOT EXISTS ${sql(forkMigrationsTable)} (
      migration_id integer PRIMARY KEY NOT NULL,
      created_at datetime NOT NULL DEFAULT current_timestamp,
      name VARCHAR(255) NOT NULL
    )
  `;
  yield* sql.withTransaction(
    Effect.forEach(
      forkMigrationEntries,
      ([id, name]) => {
        const legacyId = legacyUpstreamIdOffset + id;
        return Effect.gen(function* () {
          const legacy = yield* sql<{ readonly createdAt: string }>`
            SELECT created_at AS "createdAt"
            FROM ${sql(upstreamMigrationsTable)}
            WHERE migration_id = ${legacyId} AND name = ${name}
          `;
          if (legacy.length === 0) {
            return;
          }
          const existing = yield* sql<{ readonly name: string }>`
            SELECT name FROM ${sql(forkMigrationsTable)} WHERE migration_id = ${id}
          `;
          if (existing.length === 0) {
            yield* sql`
              INSERT INTO ${sql(forkMigrationsTable)} (migration_id, created_at, name)
              VALUES (${id}, ${legacy[0]!.createdAt}, ${name})
            `;
          } else if (existing[0]!.name !== name) {
            // Deleting the legacy row here would lose the only record that the
            // fork migration ran; refuse instead of silently skipping it.
            return yield* new Migrator.MigrationError({
              kind: "BadState",
              message: `Fork migration ledger slot ${id} holds "${existing[0]!.name}" but upstream ledger row ${legacyId} records "${name}"`,
            });
          }
          yield* sql`
            DELETE FROM ${sql(upstreamMigrationsTable)}
            WHERE migration_id = ${legacyId} AND name = ${name}
          `;
        });
      },
      { discard: true },
    ),
  );
});

export interface RunForkMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

/**
 * Run pending fork migrations against the fork ledger. Assumes upstream
 * migrations have already run; fork migrations build on upstream's tables.
 */
export const runForkMigrations = Effect.fn("runForkMigrations")(function* ({
  toMigrationInclusive,
}: RunForkMigrationsOptions = {}) {
  const executedMigrations = yield* run({
    loader: makeForkMigrationLoader(toMigrationInclusive),
    table: forkMigrationsTable,
  });
  const migrations = executedMigrations.map(([id, name]) => `fork/${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Fork database schema is current")
    : Effect.log("Fork migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));
  return executedMigrations;
});

/**
 * Boot entry point: adopt legacy fork ledger rows, run upstream migrations,
 * then run fork migrations. Adoption must come first so upstream's high-water
 * mark drops back to upstream's own latest migration before it is consulted.
 */
export const runAllMigrations = Effect.fn("runAllMigrations")(function* () {
  yield* adoptLegacyForkLedgerRows();
  const upstream = yield* runMigrations();
  const fork = yield* runForkMigrations();
  return { upstream, fork };
});
