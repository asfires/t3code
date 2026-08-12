import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import {
  applyRetractionRecoverySignal,
  RETRACTION_RECOVERY_STALE_AFTER_MS,
  resolveRetractionRecoverySignal,
} from "./RetractionRecoveryHandoff";
import {
  applyOptimisticRetractionRecoveryToThread,
  rememberOptimisticRetractionComposer,
  snapshotLastUserMessageRecovery,
  useRetractionRecoveryStore,
} from "./lastUserMessageRecovery";

const environmentId = EnvironmentId.make("environment-1");
const projectRef = scopeProjectRef(environmentId, ProjectId.make("project-1"));
const sourceThreadRef = scopeThreadRef(environmentId, ThreadId.make("source-thread"));
const requestId = CommandId.make("request-1");
const messageId = MessageId.make("message-1");
const draftId = DraftId.make("recovery-draft");
const futureThreadId = ThreadId.make("future-thread");
const createdAt = "2026-08-11T12:00:00.000Z";

beforeEach(() => {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  useRetractionRecoveryStore.setState({ byRequestId: {} });
});

async function seedRecovery() {
  await snapshotLastUserMessageRecovery({
    requestId,
    messageId,
    sourceThreadRef,
    projectRef,
    draftId,
    futureThreadId,
    createdAt,
    bundle: {
      prompt: "preserve this message",
      images: [],
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      envMode: "worktree",
      baseBranch: "main",
      startFromOrigin: true,
    },
  });
  const recovery = useRetractionRecoveryStore.getState().byRequestId[requestId];
  if (!recovery) throw new Error("Expected recovery fixture");
  return recovery;
}

describe("retraction recovery handoff", () => {
  it("hands off when completion deletes detail before the live subscription exists", async () => {
    const recovery = await seedRecovery();
    const navigate = vi.fn();
    const signal = resolveRetractionRecoverySignal({
      recovery,
      liveCompletion: null,
      projectedRetraction: null,
      activities: [],
      threadStatus: "deleted",
      threadDetailExists: false,
      shellSnapshotReady: true,
      sourceThreadInShell: true,
      nowMs: Date.parse(createdAt) + 115,
    });

    expect(signal).toEqual({ kind: "source-thread-gone" });
    expect(signal && applyRetractionRecoverySignal({ recovery, signal, navigate })).toBe(
      "draft-surfaced",
    );
    expect(navigate).toHaveBeenCalledWith({
      to: "/draft/$draftId",
      params: { draftId },
      replace: true,
    });
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.hidden).toBe(false);
    expect(useRetractionRecoveryStore.getState().byRequestId[requestId]).toBeUndefined();
  });

  it("hands off after reload when the persisted recovery mounts with its thread already gone", async () => {
    const persistedRecovery = await seedRecovery();
    const navigate = vi.fn();

    // Reinstall only the serialized recovery record to model Zustand hydration
    // before the route-level watcher mounts on a fresh client session.
    useRetractionRecoveryStore.setState({
      byRequestId: { [requestId]: persistedRecovery },
    });
    const recovery = useRetractionRecoveryStore.getState().byRequestId[requestId];
    if (!recovery) throw new Error("Expected rehydrated recovery fixture");
    const signal = resolveRetractionRecoverySignal({
      recovery,
      liveCompletion: null,
      projectedRetraction: null,
      activities: [],
      threadStatus: "empty",
      threadDetailExists: false,
      shellSnapshotReady: true,
      sourceThreadInShell: false,
      nowMs: Date.parse(createdAt) + 1_000,
    });

    expect(signal).toEqual({ kind: "source-thread-gone" });
    expect(signal && applyRetractionRecoverySignal({ recovery, signal, navigate })).toBe(
      "draft-surfaced",
    );
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
      "preserve this message",
    );
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.hidden).toBe(false);
  });

  it("keeps correlated projected completion metadata as the fast path", async () => {
    const recovery = await seedRecovery();
    const signal = resolveRetractionRecoverySignal({
      recovery,
      liveCompletion: null,
      projectedRetraction: {
        requestId,
        messageId,
        targetTurnId: null,
        firstUserMessage: true,
        status: "completed",
        completedAt: "2026-08-11T12:00:00.115Z",
      },
      activities: [],
      threadStatus: "live",
      threadDetailExists: true,
      shellSnapshotReady: true,
      sourceThreadInShell: true,
      nowMs: Date.parse(createdAt) + 115,
    });

    expect(signal?.kind).toBe("completed");
  });

  it("navigates an optimistic first-message recovery if completion beats acceptance", async () => {
    const recovery = await seedRecovery();
    useRetractionRecoveryStore.getState().setOptimisticDestination(recovery.requestId, "thread");
    const optimisticRecovery = useRetractionRecoveryStore.getState().byRequestId[requestId];
    if (!optimisticRecovery) throw new Error("Expected optimistic recovery fixture");
    const navigate = vi.fn();

    expect(
      applyRetractionRecoverySignal({
        recovery: optimisticRecovery,
        signal: {
          kind: "completed",
          completion: {
            threadId: sourceThreadRef.threadId,
            retraction: {
              requestId,
              messageId,
              turnId: null,
              firstUserMessage: true,
              completedAt: "2026-08-11T12:00:00.115Z",
            },
          },
        },
        navigate,
      }),
    ).toBe("draft-surfaced");
    expect(navigate).toHaveBeenCalledOnce();
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.hidden).toBe(false);
  });

  it("restores into an existing source composer for a correlated failed row", async () => {
    const recovery = await seedRecovery();
    const navigate = vi.fn();
    const signal = resolveRetractionRecoverySignal({
      recovery,
      liveCompletion: null,
      projectedRetraction: {
        requestId,
        messageId,
        targetTurnId: null,
        firstUserMessage: true,
        status: "failed",
        completedAt: null,
      },
      activities: [],
      threadStatus: "live",
      threadDetailExists: true,
      shellSnapshotReady: true,
      sourceThreadInShell: true,
      nowMs: Date.parse(createdAt) + 500,
    });

    expect(signal).toMatchObject({ kind: "failed", sourceThreadExists: true });
    expect(signal && applyRetractionRecoverySignal({ recovery, signal, navigate })).toBe(
      "thread-restored",
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().getComposerDraft(sourceThreadRef)?.prompt).toBe(
      "preserve this message",
    );
    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toBeNull();
  });

  it("silently restores the pre-Esc composer for an ignored boundary rejection", async () => {
    useComposerDraftStore.getState().setPrompt(sourceThreadRef, "existing draft");
    rememberOptimisticRetractionComposer({ requestId, sourceThreadRef });
    const recovery = await seedRecovery();
    useRetractionRecoveryStore.getState().setOptimisticDestination(requestId, "thread");
    applyOptimisticRetractionRecoveryToThread({
      sourceThreadRef,
      bundle: {
        prompt: "preserve this message",
        images: [],
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        envMode: "worktree",
        baseBranch: "main",
        startFromOrigin: true,
      },
    });
    expect(useComposerDraftStore.getState().getComposerDraft(sourceThreadRef)?.prompt).toBe(
      "existing draft\n\npreserve this message",
    );

    const signal = resolveRetractionRecoverySignal({
      recovery,
      liveCompletion: null,
      projectedRetraction: {
        requestId,
        messageId,
        targetTurnId: null,
        firstUserMessage: false,
        status: "failed",
        completedAt: null,
      },
      activities: [
        {
          id: "ignored-failure" as never,
          tone: "error",
          kind: "turn.retract.failed",
          summary: "Message retract failed",
          payload: { requestId, detail: "boundary unavailable", silent: true },
          turnId: null,
          createdAt: "2026-08-11T12:00:00.100Z",
        },
      ],
      threadStatus: "live",
      threadDetailExists: true,
      shellSnapshotReady: true,
      sourceThreadInShell: true,
      nowMs: Date.parse(createdAt) + 100,
    });

    expect(signal).toEqual({ kind: "ignored" });
    expect(signal && applyRetractionRecoverySignal({ recovery, signal, navigate: vi.fn() })).toBe(
      "thread-restored",
    );
    expect(useComposerDraftStore.getState().getComposerDraft(sourceThreadRef)?.prompt).toBe(
      "existing draft",
    );
    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toBeNull();
  });

  it("surfaces the recovery draft when failure activity outlives the source thread", async () => {
    const recovery = await seedRecovery();
    const navigate = vi.fn();
    const signal = resolveRetractionRecoverySignal({
      recovery,
      liveCompletion: null,
      projectedRetraction: null,
      activities: [
        {
          id: "failure-activity" as never,
          tone: "error",
          kind: "turn.retract.failed",
          summary: "Message retract failed",
          payload: { requestId, detail: "provider rollback failed" },
          turnId: null,
          createdAt: "2026-08-11T12:00:00.500Z",
        },
      ],
      threadStatus: "cached",
      threadDetailExists: true,
      shellSnapshotReady: true,
      sourceThreadInShell: false,
      nowMs: Date.parse(createdAt) + 500,
    });

    expect(signal).toEqual({
      kind: "failed",
      detail: "provider rollback failed",
      sourceThreadExists: false,
    });
    expect(signal && applyRetractionRecoverySignal({ recovery, signal, navigate })).toBe(
      "draft-surfaced",
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().getComposerDraft(sourceThreadRef)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.hidden).toBe(false);
  });

  it("surfaces a warning recovery after the bounded window when no row correlates", async () => {
    const recovery = await seedRecovery();
    const navigate = vi.fn();
    const signal = resolveRetractionRecoverySignal({
      recovery,
      liveCompletion: null,
      projectedRetraction: null,
      activities: [],
      threadStatus: "live",
      threadDetailExists: true,
      shellSnapshotReady: true,
      sourceThreadInShell: true,
      nowMs: Date.parse(createdAt) + RETRACTION_RECOVERY_STALE_AFTER_MS,
    });

    expect(signal).toEqual({ kind: "stale" });
    expect(signal && applyRetractionRecoverySignal({ recovery, signal, navigate })).toBe(
      "draft-surfaced",
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.hidden).toBe(false);
  });

  it("does not age out a correlated retraction that is still pending", async () => {
    const recovery = await seedRecovery();
    const signal = resolveRetractionRecoverySignal({
      recovery,
      liveCompletion: null,
      projectedRetraction: {
        requestId,
        messageId,
        targetTurnId: null,
        firstUserMessage: true,
        status: "requested",
        completedAt: null,
      },
      activities: [],
      threadStatus: "live",
      threadDetailExists: true,
      shellSnapshotReady: true,
      sourceThreadInShell: true,
      nowMs: Date.parse(createdAt) + RETRACTION_RECOVERY_STALE_AFTER_MS * 2,
    });

    expect(signal).toBeNull();
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.hidden).toBe(true);
  });
});
