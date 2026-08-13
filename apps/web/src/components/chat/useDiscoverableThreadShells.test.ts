import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DraftId } from "../../composerDraftStore";
import { filterDiscoverableThreadShells } from "./useDiscoverableThreadShells";

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");

function thread(id: string): EnvironmentThreadShell {
  return {
    environmentId,
    id: ThreadId.make(id),
    projectId,
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-08-13T12:00:00.000Z",
    updatedAt: "2026-08-13T12:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: "2026-08-13T12:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function recovery(threadId: ThreadId, firstUserMessage: boolean) {
  return {
    requestId: CommandId.make(`request-${threadId}`),
    messageId: MessageId.make(`message-${threadId}`),
    sourceThreadRef: scopeThreadRef(environmentId, threadId),
    projectRef: scopeProjectRef(environmentId, projectId),
    draftId: DraftId.make(`draft-${threadId}`),
    createdAt: "2026-08-13T12:00:00.000Z",
    firstUserMessage,
    optimisticDestination: "thread" as const,
  };
}

describe("discoverable thread shells", () => {
  it("hides only threads with a pending first-message recovery", () => {
    const first = thread("first-message");
    const middle = thread("mid-thread");
    const ordinary = thread("ordinary");

    expect(
      filterDiscoverableThreadShells([first, middle, ordinary], {
        first: recovery(first.id, true),
        middle: recovery(middle.id, false),
      }),
    ).toEqual([middle, ordinary]);
  });

  it("returns the original list when no first-message recovery is pending", () => {
    const threads = [thread("ordinary")];
    expect(filterDiscoverableThreadShells(threads, {})).toBe(threads);
  });
});
