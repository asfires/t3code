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
  handoffCompletedFirstMessageRetraction,
  snapshotLastUserMessageRecovery,
  useRetractionRecoveryStore,
} from "./lastUserMessageRecovery";

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");
const projectRef = scopeProjectRef(environmentId, projectId);
const sourceThreadId = ThreadId.make("source-thread");
const sourceThreadRef = scopeThreadRef(environmentId, sourceThreadId);
const requestId = CommandId.make("request-1");
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
  it("snapshots the full restore bundle into a fresh unmapped draft", async () => {
    const file = new File(["image"], "shot.png", { type: "image/png" });

    const result = await snapshotLastUserMessageRecovery({
      requestId,
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
        messageId: MessageId.make("message-1"),
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
    });
    expect(navigate).toHaveBeenCalledWith({
      to: "/draft/$draftId",
      params: { draftId },
      replace: true,
    });
    expect(useRetractionRecoveryStore.getState().byRequestId[requestId]).toBeUndefined();
  });
});
