import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import migration from "./007_DropTurnRetractionTables.ts";

for (const hasTables of [false, true]) {
  it.layer(Layer.fresh(NodeSqliteClient.layerMemory()))(
    `drop tables, existing=${hasTables}`,
    (it) => {
      it.effect("removes only obsolete tables and their indexes and can run again", () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE retained_data (value TEXT)`;
          yield* sql`INSERT INTO retained_data VALUES ('keep')`;
          if (hasTables) {
            yield* sql`CREATE TABLE projection_turn_retractions (request_id TEXT PRIMARY KEY, thread_id TEXT)`;
            yield* sql`CREATE INDEX retraction_thread ON projection_turn_retractions(thread_id)`;
            yield* sql`CREATE TABLE provider_turn_send_claims (thread_id TEXT, message_id TEXT, PRIMARY KEY(thread_id, message_id))`;
            yield* sql`INSERT INTO projection_turn_retractions VALUES ('request', 'thread')`;
            yield* sql`INSERT INTO provider_turn_send_claims VALUES ('thread', 'message')`;
          }
          yield* migration;
          yield* migration;
          const objects = yield* sql<{
            name: string;
          }>`SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name`;
          assert.deepEqual(objects, [{ name: "retained_data" }]);
          assert.deepEqual(yield* sql`SELECT * FROM retained_data`, [{ value: "keep" }]);
        }),
      );
    },
  );
}
