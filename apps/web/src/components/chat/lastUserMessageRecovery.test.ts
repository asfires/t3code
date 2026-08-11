import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import {
  buildRetractionCommandInput,
  handoffCompletedFirstMessageRetraction,
  handoffCompletedMidThreadRetraction,
  findCorrelatedRetractionFailure,
  restoreRetractionRecoveryToThread,
  snapshotLastUserMessageRecovery,
  useRetractionRecoveryStore,
} from "./lastUserMessageRecovery";

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");
const projectRef = scopeProjectRef(environmentId, projectId);
const sourceThreadId = ThreadId.make("source-thread");
const sourceThreadRef = scopeThreadRef(environmentId, sourceThreadId);
const requestId = CommandId.make("request-1");
const messageId = MessageId.make("message-1");
const draftId = DraftId.make("recovery-draft");
const futureThreadId = ThreadId.make("future-thread");

beforeEach(() => {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  useRetractionRecoveryStore.setState({ byRequestId: {} });
});

describe("last user message recovery draft", () => {
  it("reuses the persisted request ID and message correlation for reconnect dispatches", () => {
    const recovery = {
      requestId,
      messageId,
      sourceThreadRef,
      projectRef,
      draftId,
      createdAt: "2026-08-11T12:00:00.000Z",
    };

    expect(buildRetractionCommandInput(recovery)).toEqual({
      commandId: requestId,
      threadId: sourceThreadId,
      messageId,
      createdAt: recovery.createdAt,
    });
    expect(buildRetractionCommandInput(recovery)).toEqual(buildRetractionCommandInput(recovery));
  });

  it("snapshots the full restore bundle into a fresh unmapped draft", async () => {
    const file = new File(["image"], "shot.png", { type: "image/png" });

    const result = await snapshotLastUserMessageRecovery({
      requestId,
      messageId,
      sourceThreadRef,
      projectRef,
      draftId,
      futureThreadId,
      createdAt: "2026-08-11T12:00:00.000Z",
      bundle: {
        prompt: "restore this prompt",
        images: [
          {
            type: "image",
            id: "image-1",
            name: file.name,
            mimeType: file.type,
            sizeBytes: file.size,
            previewUrl: "blob:recovery-image",
            file,
          },
        ],
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex-personal"),
          model: "gpt-5.6",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
        runtimeMode: "full-access",
        interactionMode: "plan",
        envMode: "worktree",
        baseBranch: "main",
        startFromOrigin: true,
      },
      encodeImage: async () => "data:image/png;base64,aW1hZ2U=",
    });
    await Promise.resolve();

    expect(result).toEqual({ draftId, failedImageNames: [] });
    const session = useComposerDraftStore.getState().getDraftSession(draftId);
    expect(session).toMatchObject({
      threadId: futureThreadId,
      environmentId,
      projectId,
      runtimeMode: "full-access",
      interactionMode: "plan",
      envMode: "worktree",
      branch: "main",
      worktreePath: null,
      startFromOrigin: true,
      hidden: true,
    });
    expect(useComposerDraftStore.getState().getDraftSessionByProjectRef(projectRef)).toBeNull();
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)).toMatchObject({
      prompt: "restore this prompt",
      activeProvider: ProviderInstanceId.make("codex-personal"),
      runtimeMode: "full-access",
      interactionMode: "plan",
      images: [expect.objectContaining({ id: "image-1", file })],
    });
    expect(useRetractionRecoveryStore.getState().byRequestId[requestId]).toMatchObject({
      draftId,
      sourceThreadRef,
      projectRef,
    });
  });

  it("maps and navigates only a capability-gated correlated first-message completion", async () => {
    await snapshotLastUserMessageRecovery({
      requestId,
      messageId,
      sourceThreadRef,
      projectRef,
      draftId,
      futureThreadId,
      createdAt: "2026-08-11T12:00:00.000Z",
      bundle: {
        prompt: "restore this prompt",
        images: [],
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6",
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
        envMode: "local",
        baseBranch: "feature/current",
        startFromOrigin: false,
      },
    });
    const navigate = vi.fn();
    const completion = {
      threadId: sourceThreadId,
      retraction: {
        requestId,
        messageId,
        turnId: null,
        firstUserMessage: true,
        completedAt: "2026-08-11T12:00:05.000Z",
      },
    };

    expect(
      handoffCompletedFirstMessageRetraction({
        capabilityEnabled: false,
        environmentId,
        completion,
        navigate,
      }),
    ).toBe(false);
    expect(navigate).not.toHaveBeenCalled();

    expect(
      handoffCompletedFirstMessageRetraction({
        capabilityEnabled: true,
        environmentId,
        completion: {
          ...completion,
          retraction: { ...completion.retraction, firstUserMessage: false },
        },
        navigate,
      }),
    ).toBe(false);
    expect(navigate).not.toHaveBeenCalled();

    expect(
      handoffCompletedFirstMessageRetraction({
        capabilityEnabled: true,
        environmentId,
        completion,
        navigate,
      }),
    ).toBe(true);
    expect(useComposerDraftStore.getState().getDraftSessionByProjectRef(projectRef)).toMatchObject({
      draftId,
      hidden: false,
      runtimeMode: "approval-required",
      interactionMode: "default",
      envMode: "local",
      branch: "feature/current",
      startFromOrigin: false,
    });
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)).toMatchObject({
      prompt: "restore this prompt",
      activeProvider: ProviderInstanceId.make("codex"),
      runtimeMode: "approval-required",
      interactionMode: "default",
    });
    expect(navigate).toHaveBeenCalledWith({
      to: "/draft/$draftId",
      params: { draftId },
      replace: true,
    });
    expect(useRetractionRecoveryStore.getState().byRequestId[requestId]).toBeUndefined();
  });

  it("restores a correlated mid-thread completion into the same composer and cleans the hidden draft", async () => {
    const typedImage = new File(["typed"], "typed.png", { type: "image/png" });
    const recoveredImage = new File(["recovered"], "recovered.png", { type: "image/png" });
    useComposerDraftStore.getState().setPrompt(sourceThreadRef, "typed while pending");
    useComposerDraftStore.getState().addImages(sourceThreadRef, [
      {
        type: "image",
        id: "typed-image",
        name: typedImage.name,
        mimeType: typedImage.type,
        sizeBytes: typedImage.size,
        previewUrl: "typed-preview",
        file: typedImage,
      },
    ]);
    await snapshotLastUserMessageRecovery({
      requestId,
      messageId,
      sourceThreadRef,
      projectRef,
      draftId,
      futureThreadId,
      createdAt: "2026-08-11T12:00:00.000Z",
      bundle: {
        prompt: "original sent text",
        images: [
          {
            type: "image",
            id: "recovered-image",
            name: recoveredImage.name,
            mimeType: recoveredImage.type,
            sizeBytes: recoveredImage.size,
            previewUrl: "recovered-preview",
            file: recoveredImage,
          },
        ],
        modelSelection: {
          instanceId: ProviderInstanceId.make("claude-work"),
          model: "claude-opus-4-1",
        },
        runtimeMode: "approval-required",
        interactionMode: "plan",
        envMode: "local",
        baseBranch: "main",
        startFromOrigin: false,
      },
      encodeImage: async () => "data:image/png;base64,aW1hZ2U=",
    });

    const restored = handoffCompletedMidThreadRetraction({
      environmentId,
      completion: {
        threadId: sourceThreadId,
        retraction: {
          requestId,
          messageId,
          turnId: null,
          firstUserMessage: false,
          completedAt: "2026-08-11T12:00:05.000Z",
        },
      },
    });

    expect(restored).toMatchObject({
      prompt: "typed while pending\n\noriginal sent text",
      unrestoredImageNames: [],
    });
    expect(useComposerDraftStore.getState().getComposerDraft(sourceThreadRef)).toMatchObject({
      prompt: "typed while pending\n\noriginal sent text",
      activeProvider: ProviderInstanceId.make("claude-work"),
      runtimeMode: "approval-required",
      interactionMode: "plan",
      images: [
        expect.objectContaining({ id: "typed-image" }),
        expect.objectContaining({ id: "recovered-image" }),
      ],
    });
    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toBeNull();
    expect(useRetractionRecoveryStore.getState().byRequestId[requestId]).toBeUndefined();
  });

  it("restores text and removes the hidden sidebar draft when a retraction fails", async () => {
    await snapshotLastUserMessageRecovery({
      requestId,
      messageId,
      sourceThreadRef,
      projectRef,
      draftId,
      futureThreadId,
      createdAt: "2026-08-11T12:00:00.000Z",
      bundle: {
        prompt: "preserve me",
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

    expect(restoreRetractionRecoveryToThread({ requestId, sourceThreadRef })).toMatchObject({
      prompt: "preserve me",
    });
    expect(useComposerDraftStore.getState().getComposerDraft(sourceThreadRef)?.prompt).toBe(
      "preserve me",
    );
    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toBeNull();
    expect(useComposerDraftStore.getState().getDraftSessionByProjectRef(projectRef)).toBeNull();
    expect(useRetractionRecoveryStore.getState().byRequestId[requestId]).toBeUndefined();
  });

  it("finds only failure activity correlated to the pending request", () => {
    expect(
      findCorrelatedRetractionFailure(
        [
          {
            id: "event-1" as never,
            tone: "error",
            kind: "turn.retract.failed",
            summary: "Message retract failed",
            payload: { requestId: CommandId.make("other-request"), detail: "wrong failure" },
            turnId: null,
            createdAt: "2026-08-11T12:00:01.000Z",
          },
          {
            id: "event-2" as never,
            tone: "error",
            kind: "turn.retract.failed",
            summary: "Message retract failed",
            payload: { requestId, detail: "provider rollback failed" },
            turnId: null,
            createdAt: "2026-08-11T12:00:02.000Z",
          },
        ],
        requestId,
      ),
    ).toBe("provider rollback failed");
  });
});
