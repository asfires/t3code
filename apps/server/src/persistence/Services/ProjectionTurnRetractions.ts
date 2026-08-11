import {
  CheckpointRef,
  CommandId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ThreadId,
  ThreadTurnRetractionStatus,
  TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionTurnRetraction = Schema.Struct({
  requestId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  baselineTurnCount: NonNegativeInt,
  baselineCheckpointRef: CheckpointRef,
  targetTurnId: Schema.NullOr(TurnId),
  providerSendClaimed: Schema.Boolean,
  firstUserMessage: Schema.Boolean,
  requestedAt: IsoDateTime,
  status: ThreadTurnRetractionStatus,
  completedAt: Schema.NullOr(IsoDateTime),
  failedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionTurnRetraction = typeof ProjectionTurnRetraction.Type;

const ProjectionTurnRetractionRequest = Schema.Struct({ requestId: CommandId });
const ProjectionTurnRetractionThread = Schema.Struct({ threadId: ThreadId });
const MarkProjectionTurnRetractionCompleted = Schema.Struct({
  requestId: CommandId,
  completedAt: IsoDateTime,
  targetTurnId: Schema.NullOr(TurnId),
});
const MarkProjectionTurnRetractionFailed = Schema.Struct({
  requestId: CommandId,
  failedAt: IsoDateTime,
});

export interface ProjectionTurnRetractionRepositoryShape {
  readonly upsertPending: (
    row: ProjectionTurnRetraction,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly markCompleted: (
    input: typeof MarkProjectionTurnRetractionCompleted.Type,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly markFailed: (
    input: typeof MarkProjectionTurnRetractionFailed.Type,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getByRequestId: (
    input: typeof ProjectionTurnRetractionRequest.Type,
  ) => Effect.Effect<Option.Option<ProjectionTurnRetraction>, ProjectionRepositoryError>;
  readonly getLatestByThreadId: (
    input: typeof ProjectionTurnRetractionThread.Type,
  ) => Effect.Effect<Option.Option<ProjectionTurnRetraction>, ProjectionRepositoryError>;
  readonly listPending: () => Effect.Effect<
    ReadonlyArray<ProjectionTurnRetraction>,
    ProjectionRepositoryError
  >;
}

export class ProjectionTurnRetractionRepository extends Context.Service<
  ProjectionTurnRetractionRepository,
  ProjectionTurnRetractionRepositoryShape
>()("t3/persistence/Services/ProjectionTurnRetractions/ProjectionTurnRetractionRepository") {}

export {
  MarkProjectionTurnRetractionCompleted,
  MarkProjectionTurnRetractionFailed,
  ProjectionTurnRetractionRequest,
  ProjectionTurnRetractionThread,
};
