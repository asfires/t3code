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

import { runMigrations } from "./Migrations.ts";
import ForkMigration007 from "./ForkMigrations/007_DropTurnRetractionTables.ts";
import ForkMigration003 from "./ForkMigrations/003_ProjectionManagedWorktrees.ts";

export const forkMigrationsTable = "effect_sql_migrations_fork";

// Retraction migration IDs 1, 2, 4, 5, and 6 are retired; never reuse them.
export const forkMigrationEntries = [
  [3, "ProjectionManagedWorktrees", ForkMigration003],
  [7, "DropTurnRetractionTables", ForkMigration007],
] as const;

export const forkMigrationManifest = forkMigrationEntries.map(([id, name]) => [id, name] as const);

const makeForkMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      forkMigrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

const run = Migrator.make({});

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

/** Run upstream migrations, then the independent fork migrations. */
export const runAllMigrations = Effect.fn("runAllMigrations")(function* () {
  const upstream = yield* runMigrations();
  const fork = yield* runForkMigrations();
  return { upstream, fork };
});
