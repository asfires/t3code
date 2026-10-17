import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import {
  forkMigrationManifest,
  forkMigrationsTable,
  runAllMigrations,
  runForkMigrations,
} from "./ForkMigrations.ts";

const freshLayer = () =>
  it.layer(Layer.fresh(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" }))));

const readLedger = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ readonly id: number; readonly name: string }>`
      SELECT migration_id AS id, name FROM ${sql(table)} ORDER BY migration_id ASC
    `;
  });

const imageRecord = {
  version: 1,
  contextId: "image_b",
  label: "shot.png",
  kind: "image",
  attachmentId: "attachment-b",
};
const fileRecord = {
  version: 1,
  contextId: "file_d",
  label: "notes.txt",
  kind: "file",
  attachmentId: "attachment-d",
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 12,
};

const message = (messageId: string, text: string, context: unknown) => ({
  message_id: messageId,
  thread_id: "thread",
  turn_id: null,
  role: "user",
  text,
  is_streaming: 0,
  created_at: "2026-09-17T00:00:00.000Z",
  updated_at: "2026-09-17T00:00:00.000Z",
  attachments_json: null,
  context_json: context === null ? null : JSON.stringify(context),
});

freshLayer()("ForkMigrations on a fresh database", (it) => {
  it.effect("records fork migrations in their own ledger after upstream's", () =>
    Effect.gen(function* () {
      const result = yield* runAllMigrations();

      assert.deepEqual(
        result.upstream.map(([id]) => id),
        migrationManifest.map(([id]) => id),
      );
      assert.deepEqual(result.fork, forkMigrationManifest);
      assert.deepEqual(yield* readLedger(forkMigrationsTable), [
        { id: 8, name: "InlinePastedTextContext" },
      ]);
      assert.deepEqual(yield* runAllMigrations(), { upstream: [], fork: [] });
    }),
  );
});

freshLayer()("ForkMigrations on a database from the V1 fork", (it) => {
  it.effect("puts pasted-text chips back into their messages before the V2 import", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // The last V1 fork build: upstream ledger at 53, fork ledger at 7.
      yield* runMigrations({ toMigrationInclusive: 53 });
      yield* runForkMigrations({ toMigrationInclusive: 7 });
      for (const id of [1, 2, 3, 4, 5, 6, 7]) {
        yield* sql`INSERT INTO ${sql(forkMigrationsTable)} (migration_id, name)
          VALUES (${id}, ${`RetiredMigration${id}`})`;
      }
      const rows = [
        message(
          "mixed",
          "see [Pasted text](t3-context://v1/pasted-text/pasted-text_a) and ![shot.png](t3-context://v1/image/image_b)",
          {
            version: 1,
            records: [
              {
                version: 1,
                contextId: "pasted-text_a",
                label: "Pasted text",
                kind: "pasted-text",
                text: "line one\n  line two\n",
              },
              imageRecord,
            ],
          },
        ),
        message("paste-only", "[Pasted text](t3-context://v1/pasted-text/pasted-text_c)", {
          version: 1,
          records: [
            {
              version: 1,
              contextId: "pasted-text_c",
              label: "Pasted text",
              kind: "pasted-text",
              text: "only the paste",
            },
          ],
        }),
        message("file-only", "[notes.txt](t3-context://v1/file/file_d)", {
          version: 1,
          records: [fileRecord],
        }),
        message("plain", "no context here", null),
      ];
      for (const row of rows) {
        yield* sql`INSERT INTO projection_thread_messages ${sql.insert(row)}`;
      }

      const result = yield* runAllMigrations();
      assert.deepEqual(
        result.upstream.map(([id]) => id),
        migrationManifest.filter(([id]) => id > 53).map(([id]) => id),
      );
      assert.deepEqual(result.fork, [[8, "InlinePastedTextContext"]]);
      assert.deepEqual(
        (yield* readLedger(forkMigrationsTable)).map((row) => row.id),
        [1, 2, 3, 4, 5, 6, 7, 8],
      );

      const migrated = yield* sql<{
        readonly message_id: string;
        readonly text: string;
        readonly context_json: string | null;
      }>`SELECT message_id, text, context_json FROM projection_thread_messages ORDER BY message_id`;
      assert.deepEqual(migrated, [
        {
          message_id: "file-only",
          text: "[notes.txt](t3-context://v1/file/file_d)",
          context_json: JSON.stringify({ version: 1, records: [fileRecord] }),
        },
        {
          message_id: "mixed",
          text: "see line one\n  line two\n and ![shot.png](t3-context://v1/image/image_b)",
          context_json: JSON.stringify({ version: 1, records: [imageRecord] }),
        },
        { message_id: "paste-only", text: "only the paste", context_json: null },
        { message_id: "plain", text: "no context here", context_json: null },
      ]);
      assert.deepEqual(yield* runAllMigrations(), { upstream: [], fork: [] });
    }),
  );
});
