/**
 * Durable process manager for pending turn retractions.
 *
 * Runtime and domain events are only wakeups. Every transition is decided
 * from projected state, and startup scans all requested rows.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface TurnRetractionReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class TurnRetractionReactor extends Context.Service<
  TurnRetractionReactor,
  TurnRetractionReactorShape
>()("t3/orchestration/Services/TurnRetractionReactor") {}
