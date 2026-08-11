import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  MarkProjectionTurnRetractionCompleted,
  MarkProjectionTurnRetractionFailed,
  CancelProjectionTurnProviderSend,
  ProjectionTurnRetraction,
  ProjectionTurnRetractionRepository,
  ProjectionTurnRetractionRequest,
  ProjectionTurnRetractionThread,
  ProjectionTurnProviderSend,
  type ProjectionTurnRetractionRepositoryShape,
} from "../Services/ProjectionTurnRetractions.ts";

const ProjectionTurnRetractionDbRow = ProjectionTurnRetraction.mapFields(
  Struct.assign({
    providerSendClaimed: Schema.Number,
    firstUserMessage: Schema.Number,
  }),
);

function mapRow(row: typeof ProjectionTurnRetractionDbRow.Type): ProjectionTurnRetraction {
  const providerSendState = row.providerSendClaimed !== 0 ? "claimed" : row.providerSendState;
  return {
    ...row,
    providerSendClaimed: providerSendState === "claimed",
    providerSendState,
    firstUserMessage: row.firstUserMessage !== 0,
  };
}

function sqlOrDecode(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertPendingRow = SqlSchema.void({
    Request: ProjectionTurnRetractionDbRow,
    execute: (row) => sql`
      INSERT INTO projection_turn_retractions (
        request_id, thread_id, message_id, baseline_turn_count, baseline_checkpoint_ref,
        target_turn_id, provider_send_claimed, provider_send_state, first_user_message, requested_at,
        status, completed_at, failed_at
      ) VALUES (
        ${row.requestId}, ${row.threadId}, ${row.messageId}, ${row.baselineTurnCount},
        ${row.baselineCheckpointRef}, ${row.targetTurnId},
        CASE WHEN EXISTS (
          SELECT 1 FROM provider_turn_send_claims
          WHERE thread_id = ${row.threadId} AND message_id = ${row.messageId}
        ) THEN 1 ELSE ${row.providerSendClaimed} END,
        CASE WHEN EXISTS (
          SELECT 1 FROM provider_turn_send_claims
          WHERE thread_id = ${row.threadId} AND message_id = ${row.messageId}
        ) THEN 'claimed' ELSE ${row.providerSendState} END,
        ${row.firstUserMessage}, ${row.requestedAt}, ${row.status}, ${row.completedAt}, ${row.failedAt}
      )
      ON CONFLICT (request_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        message_id = excluded.message_id,
        baseline_turn_count = excluded.baseline_turn_count,
        baseline_checkpoint_ref = excluded.baseline_checkpoint_ref,
        target_turn_id = excluded.target_turn_id,
        provider_send_claimed = projection_turn_retractions.provider_send_claimed,
        provider_send_state = projection_turn_retractions.provider_send_state,
        first_user_message = excluded.first_user_message,
        requested_at = excluded.requested_at,
        status = excluded.status,
        completed_at = excluded.completed_at,
        failed_at = excluded.failed_at
    `,
  });

  const markCompletedRow = SqlSchema.void({
    Request: MarkProjectionTurnRetractionCompleted,
    execute: (input) => sql`
      UPDATE projection_turn_retractions
      SET status = 'completed', completed_at = ${input.completedAt},
          target_turn_id = COALESCE(${input.targetTurnId}, target_turn_id), failed_at = NULL
      WHERE request_id = ${input.requestId}
    `,
  });

  const markFailedRow = SqlSchema.void({
    Request: MarkProjectionTurnRetractionFailed,
    execute: (input) => sql`
      UPDATE projection_turn_retractions
      SET status = 'failed', failed_at = ${input.failedAt}, completed_at = NULL
      WHERE request_id = ${input.requestId}
    `,
  });

  const getPendingByMessageRow = SqlSchema.findOneOption({
    Request: CancelProjectionTurnProviderSend,
    Result: ProjectionTurnRetractionDbRow,
    execute: ({ threadId, messageId }) => sql`
      SELECT request_id AS "requestId", thread_id AS "threadId", message_id AS "messageId",
        baseline_turn_count AS "baselineTurnCount", baseline_checkpoint_ref AS "baselineCheckpointRef",
        target_turn_id AS "targetTurnId", provider_send_claimed AS "providerSendClaimed",
        provider_send_state AS "providerSendState", first_user_message AS "firstUserMessage",
        requested_at AS "requestedAt", status, completed_at AS "completedAt", failed_at AS "failedAt"
      FROM projection_turn_retractions
      WHERE thread_id = ${threadId} AND message_id = ${messageId} AND status = 'requested'
      LIMIT 1
    `,
  });

  const markProviderSendCancelledRow = SqlSchema.void({
    Request: ProjectionTurnRetractionRequest,
    execute: ({ requestId }) => sql`
      UPDATE projection_turn_retractions
      SET provider_send_claimed = 0, provider_send_state = 'cancelled'
      WHERE request_id = ${requestId} AND status = 'requested'
        AND provider_send_state = 'unclaimed'
    `,
  });

  const upsertProviderSendClaimRow = SqlSchema.void({
    Request: ProjectionTurnProviderSend,
    execute: ({ threadId, messageId, claimedAt }) => sql`
      INSERT INTO provider_turn_send_claims (thread_id, message_id, claimed_at)
      VALUES (${threadId}, ${messageId}, ${claimedAt})
      ON CONFLICT (thread_id, message_id) DO NOTHING
    `,
  });

  const getByRequestIdRow = SqlSchema.findOneOption({
    Request: ProjectionTurnRetractionRequest,
    Result: ProjectionTurnRetractionDbRow,
    execute: ({ requestId }) => sql`
      SELECT request_id AS "requestId", thread_id AS "threadId", message_id AS "messageId",
        baseline_turn_count AS "baselineTurnCount", baseline_checkpoint_ref AS "baselineCheckpointRef",
        target_turn_id AS "targetTurnId", provider_send_claimed AS "providerSendClaimed",
        provider_send_state AS "providerSendState",
        first_user_message AS "firstUserMessage", requested_at AS "requestedAt", status,
        completed_at AS "completedAt", failed_at AS "failedAt"
      FROM projection_turn_retractions WHERE request_id = ${requestId} LIMIT 1
    `,
  });

  const getLatestByThreadIdRow = SqlSchema.findOneOption({
    Request: ProjectionTurnRetractionThread,
    Result: ProjectionTurnRetractionDbRow,
    execute: ({ threadId }) => sql`
      SELECT request_id AS "requestId", thread_id AS "threadId", message_id AS "messageId",
        baseline_turn_count AS "baselineTurnCount", baseline_checkpoint_ref AS "baselineCheckpointRef",
        target_turn_id AS "targetTurnId", provider_send_claimed AS "providerSendClaimed",
        provider_send_state AS "providerSendState",
        first_user_message AS "firstUserMessage", requested_at AS "requestedAt", status,
        completed_at AS "completedAt", failed_at AS "failedAt"
      FROM projection_turn_retractions WHERE thread_id = ${threadId}
      ORDER BY
        CASE WHEN status = 'requested' THEN 0 ELSE 1 END ASC,
        requested_at DESC,
        request_id DESC
      LIMIT 1
    `,
  });

  const listPendingRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionTurnRetractionDbRow,
    execute: () => sql`
      SELECT request_id AS "requestId", thread_id AS "threadId", message_id AS "messageId",
        baseline_turn_count AS "baselineTurnCount", baseline_checkpoint_ref AS "baselineCheckpointRef",
        target_turn_id AS "targetTurnId", provider_send_claimed AS "providerSendClaimed",
        provider_send_state AS "providerSendState",
        first_user_message AS "firstUserMessage", requested_at AS "requestedAt", status,
        completed_at AS "completedAt", failed_at AS "failedAt"
      FROM projection_turn_retractions WHERE status = 'requested'
      ORDER BY requested_at ASC, request_id ASC
    `,
  });

  const mapError = sqlOrDecode(
    "ProjectionTurnRetractionRepository:query",
    "ProjectionTurnRetractionRepository:decode",
  );

  return ProjectionTurnRetractionRepository.of({
    upsertPending: (row) =>
      upsertPendingRow({
        ...row,
        providerSendClaimed: row.providerSendClaimed ? 1 : 0,
        firstUserMessage: row.firstUserMessage ? 1 : 0,
      }).pipe(Effect.mapError(mapError)),
    markCompleted: (input) => markCompletedRow(input).pipe(Effect.mapError(mapError)),
    markFailed: (input) => markFailedRow(input).pipe(Effect.mapError(mapError)),
    claimProviderSend: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const pending = yield* getPendingByMessageRow(input);
            if (Option.isSome(pending)) {
              const row = mapRow(pending.value);
              if (row.providerSendState === "cancelled") {
                return "cancelled" as const;
              }
              if (row.providerSendState === "unclaimed") {
                yield* markProviderSendCancelledRow({ requestId: row.requestId });
                return "cancelled" as const;
              }
            }

            yield* upsertProviderSendClaimRow(input);
            return "claimed" as const;
          }),
        )
        .pipe(Effect.mapError(mapError)),
    cancelPendingProviderSend: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const pending = yield* getPendingByMessageRow(input);
            if (Option.isNone(pending)) {
              return false;
            }
            const row = mapRow(pending.value);
            if (row.providerSendState === "claimed") {
              return false;
            }
            if (row.providerSendState === "unclaimed") {
              yield* markProviderSendCancelledRow({ requestId: row.requestId });
            }
            return true;
          }),
        )
        .pipe(Effect.mapError(mapError)),
    getByRequestId: (input) =>
      getByRequestIdRow(input).pipe(Effect.map(Option.map(mapRow)), Effect.mapError(mapError)),
    getLatestByThreadId: (input) =>
      getLatestByThreadIdRow(input).pipe(Effect.map(Option.map(mapRow)), Effect.mapError(mapError)),
    listPending: () =>
      listPendingRows(undefined).pipe(
        Effect.map((rows) => rows.map(mapRow)),
        Effect.mapError(mapError),
      ),
  } satisfies ProjectionTurnRetractionRepositoryShape);
});

export const ProjectionTurnRetractionRepositoryLive = Layer.effect(
  ProjectionTurnRetractionRepository,
  make,
);
