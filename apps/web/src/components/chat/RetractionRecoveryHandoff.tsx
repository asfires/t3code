import { useAtomValue } from "@effect/atom-react";
import type {
  OrchestrationThreadActivity,
  OrchestrationThreadTurnRetraction,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useState } from "react";

import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useEnvironmentThreadRefs, useThread, useThreadStatus } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { threadRetractionCompletions } from "../../state/retractionCompletions";
import { environmentShell } from "../../state/shell";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  type FirstMessageRetractionCompletion,
  findCorrelatedRetractionFailure,
  handoffCompletedFirstMessageRetraction,
  handoffCompletedMidThreadRetraction,
  type PendingRetractionRecovery,
  restoreRetractionRecoveryToThread,
  surfaceRetractionRecoveryDraft,
  useRetractionRecoveryStore,
} from "./lastUserMessageRecovery";

export const RETRACTION_RECOVERY_STALE_AFTER_MS = 60_000;

type ThreadDetailStatus = "empty" | "cached" | "synchronizing" | "live" | "deleted";
type RetractionProjection = Pick<
  OrchestrationThreadTurnRetraction,
  "requestId" | "messageId" | "targetTurnId" | "firstUserMessage" | "status" | "completedAt"
>;

export type RetractionRecoverySignal =
  | { kind: "completed"; completion: FirstMessageRetractionCompletion }
  | { kind: "failed"; detail: string; sourceThreadExists: boolean }
  | { kind: "source-thread-gone" }
  | { kind: "stale" }
  | null;

function correlatedCompletion(input: {
  recovery: PendingRetractionRecovery;
  liveCompletion: FirstMessageRetractionCompletion | null;
  projectedRetraction: RetractionProjection | null;
}): FirstMessageRetractionCompletion | null {
  const liveMetadata = input.liveCompletion?.retraction;
  if (
    input.liveCompletion?.threadId === input.recovery.sourceThreadRef.threadId &&
    liveMetadata?.requestId === input.recovery.requestId
  ) {
    return input.liveCompletion;
  }

  const projected = input.projectedRetraction;
  if (
    projected?.status !== "completed" ||
    projected.requestId !== input.recovery.requestId ||
    projected.completedAt === null
  ) {
    return null;
  }
  return {
    threadId: input.recovery.sourceThreadRef.threadId,
    retraction: {
      requestId: projected.requestId,
      messageId: projected.messageId,
      turnId: projected.targetTurnId,
      firstUserMessage: projected.firstUserMessage,
      completedAt: projected.completedAt,
    },
  };
}

/**
 * Resolves transient and durable recovery evidence in priority order. Failure
 * correlation wins over disappearance, then completion metadata keeps the
 * low-latency path, and finally deletion/shell absence provide the race-proof
 * first-message handoff.
 */
export function resolveRetractionRecoverySignal(input: {
  recovery: PendingRetractionRecovery;
  liveCompletion: FirstMessageRetractionCompletion | null;
  projectedRetraction: RetractionProjection | null;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  threadStatus: ThreadDetailStatus;
  threadDetailExists: boolean;
  shellSnapshotReady: boolean;
  sourceThreadInShell: boolean;
  nowMs: number;
}): RetractionRecoverySignal {
  const activityFailure = findCorrelatedRetractionFailure(
    input.activities,
    input.recovery.requestId,
  );
  const projectedFailure =
    input.projectedRetraction?.requestId === input.recovery.requestId &&
    input.projectedRetraction.status === "failed";
  const sourceThreadExists =
    input.threadStatus !== "deleted" &&
    (input.shellSnapshotReady ? input.sourceThreadInShell : input.threadDetailExists);
  if (projectedFailure || activityFailure !== null) {
    return {
      kind: "failed",
      detail: activityFailure ?? "The server could not retract this message.",
      sourceThreadExists,
    };
  }

  const completion = correlatedCompletion(input);
  if (completion !== null) {
    return { kind: "completed", completion };
  }

  if (
    input.threadStatus === "deleted" ||
    (input.shellSnapshotReady && !input.sourceThreadInShell)
  ) {
    return { kind: "source-thread-gone" };
  }

  const createdAtMs = Date.parse(input.recovery.createdAt);
  const hasCorrelatedPendingRow =
    input.projectedRetraction?.requestId === input.recovery.requestId &&
    input.projectedRetraction.status === "requested";
  const stale =
    input.threadDetailExists &&
    !hasCorrelatedPendingRow &&
    Number.isFinite(createdAtMs) &&
    input.nowMs - createdAtMs >= RETRACTION_RECOVERY_STALE_AFTER_MS;
  return stale ? { kind: "stale" } : null;
}

export function applyRetractionRecoverySignal(input: {
  recovery: PendingRetractionRecovery;
  signal: Exclude<RetractionRecoverySignal, null>;
  navigate: (input: {
    to: "/draft/$draftId";
    params: { draftId: DraftId };
    replace: true;
  }) => unknown;
}): "draft-surfaced" | "thread-restored" | null {
  if (input.signal.kind === "completed") {
    if (input.signal.completion.retraction?.firstUserMessage) {
      return handoffCompletedFirstMessageRetraction({
        capabilityEnabled: true,
        environmentId: input.recovery.sourceThreadRef.environmentId,
        completion: input.signal.completion,
        navigate: input.navigate,
      })
        ? "draft-surfaced"
        : null;
    }
    return handoffCompletedMidThreadRetraction({
      environmentId: input.recovery.sourceThreadRef.environmentId,
      completion: input.signal.completion,
    })
      ? "thread-restored"
      : null;
  }

  if (input.signal.kind === "failed" && input.signal.sourceThreadExists) {
    const restored = restoreRetractionRecoveryToThread({
      requestId: input.recovery.requestId,
      sourceThreadRef: input.recovery.sourceThreadRef,
    });
    if (restored !== null) return "thread-restored";
  }

  return surfaceRetractionRecoveryDraft({
    requestId: input.recovery.requestId,
    sourceThreadRef: input.recovery.sourceThreadRef,
    ...(input.signal.kind === "source-thread-gone" ? { navigate: input.navigate } : {}),
  })
    ? "draft-surfaced"
    : null;
}

function PendingRetractionRecoveryWatcher(props: {
  recovery: PendingRetractionRecovery;
  navigate: (input: {
    to: "/draft/$draftId";
    params: { draftId: DraftId };
    replace: true;
  }) => unknown;
}) {
  const recoveryDraftReady = useComposerDraftStore(
    (store) => store.getDraftSession(props.recovery.draftId) !== null,
  );
  const sourceThread = useThread(props.recovery.sourceThreadRef);
  const threadStatus = useThreadStatus(props.recovery.sourceThreadRef);
  const environmentThreadRefs = useEnvironmentThreadRefs(
    props.recovery.sourceThreadRef.environmentId,
  );
  const shell = useEnvironmentQuery(
    environmentShell.stateAtom(props.recovery.sourceThreadRef.environmentId),
  );
  const result = useAtomValue(
    threadRetractionCompletions({
      environmentId: props.recovery.sourceThreadRef.environmentId,
      input: { threadId: props.recovery.sourceThreadRef.threadId, turnLimit: 1 },
    }),
  );
  const liveCompletion = Option.getOrNull(AsyncResult.value(result));
  const projectedRetraction = sourceThread?.turnRetraction ?? null;
  const shellSnapshotReady = shell.data?.snapshot._tag === "Some";
  const sourceThreadInShell = environmentThreadRefs.some(
    (ref) => ref.threadId === props.recovery.sourceThreadRef.threadId,
  );
  const [nowMs, setNowMs] = useState(Date.now);

  useEffect(() => {
    const createdAtMs = Date.parse(props.recovery.createdAt);
    if (!Number.isFinite(createdAtMs)) return;
    const remainingMs = createdAtMs + RETRACTION_RECOVERY_STALE_AFTER_MS - Date.now();
    if (remainingMs <= 0) {
      setNowMs(Date.now());
      return;
    }
    const timeout = window.setTimeout(() => setNowMs(Date.now()), remainingMs);
    return () => window.clearTimeout(timeout);
  }, [props.recovery.createdAt]);

  const signal = resolveRetractionRecoverySignal({
    recovery: props.recovery,
    liveCompletion,
    projectedRetraction,
    activities: sourceThread?.activities ?? [],
    threadStatus,
    threadDetailExists: sourceThread !== null,
    shellSnapshotReady,
    sourceThreadInShell,
    nowMs,
  });

  useEffect(() => {
    if (signal === null || !recoveryDraftReady) return;
    const outcome = applyRetractionRecoverySignal({
      recovery: props.recovery,
      signal,
      navigate: props.navigate,
    });
    if (outcome === null) return;

    if (signal.kind === "failed") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title:
            outcome === "thread-restored"
              ? "Message restored, but the turn could not be retracted"
              : "Recovery draft preserved because the turn could not be retracted",
          description: signal.detail,
        }),
      );
    } else if (signal.kind === "stale") {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Recovery draft preserved",
          description:
            "The retraction result could not be confirmed after 60 seconds, so your message is visible as a draft in the sidebar.",
        }),
      );
    }
  }, [props.navigate, props.recovery, recoveryDraftReady, signal]);

  return null;
}

export function RetractionRecoveryHandoff(props: {
  navigate: (input: {
    to: "/draft/$draftId";
    params: { draftId: DraftId };
    replace: true;
  }) => unknown;
}) {
  // Select the stable map reference; deriving Object.values inside the
  // selector returns a fresh array every snapshot and loops the store.
  const byRequestId = useRetractionRecoveryStore((state) => state.byRequestId);
  return Object.values(byRequestId).map((recovery) => (
    <PendingRetractionRecoveryWatcher
      key={recovery.requestId}
      recovery={recovery}
      navigate={props.navigate}
    />
  ));
}
