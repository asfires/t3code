import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

interface PastedTextRecord {
  readonly kind: "pasted-text";
  readonly contextId: string;
  readonly text: string;
}

const isPastedTextRecord = (record: unknown): record is PastedTextRecord =>
  typeof record === "object" &&
  record !== null &&
  "kind" in record &&
  record.kind === "pasted-text" &&
  "contextId" in record &&
  typeof record.contextId === "string" &&
  "text" in record &&
  typeof record.text === "string";

/**
 * Swaps each pasted-text chip reference for the text it held and drops the chip
 * records, which is how older fork builds sent pastes to servers without a record
 * channel. Undefined when the message holds no chips.
 */
function inlinePastedText(text: string, contextJson: string) {
  let context: unknown;
  try {
    context = JSON.parse(contextJson);
  } catch {
    return undefined;
  }
  if (typeof context !== "object" || context === null || !("records" in context)) return undefined;
  if (!Array.isArray(context.records)) return undefined;
  const records: ReadonlyArray<unknown> = context.records;
  const pastes = new Map(
    records.filter(isPastedTextRecord).map((record) => [record.contextId, record.text]),
  );
  if (pastes.size === 0) return undefined;
  const remaining = records.filter((record) => !isPastedTextRecord(record));
  return {
    text: replaceComposerContextReferences(text, (reference) =>
      reference.kind === "pasted-text"
        ? (pastes.get(reference.contextId) ?? reference.source)
        : reference.source,
    ),
    contextJson: remaining.length === 0 ? null : JSON.stringify({ ...context, records: remaining }),
  };
}

/**
 * Upstream's message context has no pasted-text record, so the V2 thread import
 * would drop these chips and leave their links pointing at nothing. Fork
 * migrations run before that import reads `projection_thread_messages`.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A fresh database stops having V1 tables once upstream stops creating them.
  const tables = yield* sql`
    SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'projection_thread_messages'
  `;
  if (tables.length === 0) return;
  const rows = yield* sql<{
    readonly message_id: string;
    readonly text: string;
    readonly context_json: string;
  }>`
    SELECT message_id, text, context_json
    FROM projection_thread_messages
    WHERE json_valid(context_json)
      AND EXISTS (
        SELECT 1 FROM json_each(context_json, '$.records') AS record
        WHERE json_extract(record.value, '$.kind') = 'pasted-text'
      )
  `;
  for (const row of rows) {
    const inlined = inlinePastedText(row.text, row.context_json);
    if (inlined === undefined) continue;
    yield* sql`
      UPDATE projection_thread_messages
      SET text = ${inlined.text}, context_json = ${inlined.contextJson}
      WHERE message_id = ${row.message_id}
    `;
  }
});
