import {
  CommandId,
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { DraftId } from "../../composerDraftStore";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";
import { useRetractionRecoveryStore } from "./lastUserMessageRecovery";
import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";
import {
  deriveEffectiveSessionPresentation,
  findPendingRetractionForThread,
  isRetractedTurnPresentationSuppressed,
  suppressRetractedTurnPhase,
} from "./retractedTurnPresentation";

const environmentId = EnvironmentId.make("environment-1");
const projectRef = scopeProjectRef(environmentId, ProjectId.make("project-1"));
const threadId = ThreadId.make("thread-1");
const threadRef = scopeThreadRef(environmentId, threadId);
const siblingThreadRef = scopeThreadRef(environmentId, ThreadId.make("thread-2"));
const requestId = CommandId.make("request-1");
const retractedTurnId = TurnId.make("turn-1");
const nextTurnId = TurnId.make("turn-2");

const recovery = {
  requestId,
  messageId: MessageId.make("message-1"),
  sourceThreadRef: threadRef,
  projectRef,
  draftId: DraftId.make("recovery-draft"),
  createdAt: "2026-08-11T12:00:00.000Z",
};

const idlePresentationInput = {
  retractionPending: false,
  latestTurnSettled: false,
  isSendBusy: false,
  heldSendPending: false,
  isConnecting: false,
  isRevertingCheckpoint: false,
};

function presentation(
  overrides: Partial<Parameters<typeof deriveEffectiveSessionPresentation>[0]> = {},
) {
  return deriveEffectiveSessionPresentation({
    phase: "running",
    pendingRetraction: recovery,
    projectedRetraction: null,
    activeTurnId: retractedTurnId,
    ...idlePresentationInput,
    retractionPending: true,
    ...overrides,
  });
}

function timelineWorkingRowIds(isWorking: boolean) {
  return deriveMessagesTimelineRows({
    timelineEntries: [],
    latestTurn: null,
    isWorking,
    activeTurnStartedAt: "2026-08-11T12:00:00.000Z",
    turnDiffSummaryByAssistantMessageId: new Map(),
    revertTurnCountByUserMessageId: new Map(),
  }).map((row) => row.kind);
}

const runningSession = {
  threadId,
  status: "running" as const,
  providerName: "Claude",
  providerInstanceId: ProviderInstanceId.make("claude"),
  runtimeMode: DEFAULT_RUNTIME_MODE,
  activeTurnId: retractedTurnId,
  lastError: null,
  updatedAt: "2026-08-11T12:00:00.000Z",
};
const idleThread = { hasPendingApprovals: false, hasPendingUserInput: false };

beforeEach(() => {
  useRetractionRecoveryStore.setState({ byRequestId: {} });
});

describe("retracted turn presentation suppression", () => {
  it("hides the running turn while the client knows a retraction is pending", () => {
    const suppressed = presentation();

    expect(suppressed.retractedTurnSuppressed).toBe(true);
    expect(suppressed.phase).toBe("ready");
    expect(suppressed.isWorking).toBe(false);
    expect(suppressed.activeTurnInProgress).toBe(false);
  });

  it("drops the timeline working row while suppressed and keeps it otherwise", () => {
    expect(timelineWorkingRowIds(presentation().isWorking)).not.toContain("working");
    expect(timelineWorkingRowIds(presentation({ pendingRetraction: null }).isWorking)).toContain(
      "working",
    );
  });

  it("keeps the sidebar row settled while suppressed", () => {
    expect(
      resolveSidebarThreadStatus(
        { ...idleThread, session: runningSession },
        { suppressRunningTurn: true },
      ),
    ).toBe("ready");
    expect(resolveSidebarThreadStatus({ ...idleThread, session: runningSession })).toBe("working");
  });

  it("still reports genuine background work in the sidebar while suppressed", () => {
    expect(
      resolveSidebarThreadStatus(
        { ...idleThread, session: runningSession, backgroundLiveness: "working" },
        { suppressRunningTurn: true },
      ),
    ).toBe("working");
  });

  it("presents a starting session as settled too, so nothing reads as Connecting", () => {
    expect(suppressRetractedTurnPhase("connecting", true)).toBe("ready");
    expect(suppressRetractedTurnPhase("disconnected", true)).toBe("disconnected");
    expect(suppressRetractedTurnPhase("running", false)).toBe("running");
  });

  it("holds suppression until the server acknowledges the retraction", () => {
    expect(
      presentation({
        projectedRetraction: { requestId, targetTurnId: retractedTurnId, status: "requested" },
      }).retractedTurnSuppressed,
    ).toBe(true);
  });
});

describe("retracted turn presentation lifetime", () => {
  it("stops suppressing once the completed retraction forgets the recovery", () => {
    useRetractionRecoveryStore.getState().remember(recovery);
    expect(
      findPendingRetractionForThread(useRetractionRecoveryStore.getState().byRequestId, threadRef),
    ).toMatchObject({ requestId });

    useRetractionRecoveryStore.getState().forget(requestId);
    const pendingRetraction = findPendingRetractionForThread(
      useRetractionRecoveryStore.getState().byRequestId,
      threadRef,
    );

    expect(pendingRetraction).toBeNull();
    const settled = presentation({ pendingRetraction, retractionPending: false });
    expect(settled.retractedTurnSuppressed).toBe(false);
    expect(settled.phase).toBe("running");
    expect(settled.isWorking).toBe(true);
  });

  it("restores the true running presentation when the retraction fails", () => {
    const failed = presentation({
      projectedRetraction: { requestId, targetTurnId: retractedTurnId, status: "failed" },
    });

    expect(failed.retractedTurnSuppressed).toBe(false);
    expect(failed.phase).toBe("running");
    expect(failed.isWorking).toBe(true);
    expect(timelineWorkingRowIds(failed.isWorking)).toContain("working");
  });
});

describe("retracted turn presentation scope", () => {
  it("leaves sibling threads untouched", () => {
    useRetractionRecoveryStore.getState().remember(recovery);
    const byRequestId = useRetractionRecoveryStore.getState().byRequestId;

    expect(findPendingRetractionForThread(byRequestId, siblingThreadRef)).toBeNull();
    expect(
      findPendingRetractionForThread(
        byRequestId,
        scopeThreadRef(EnvironmentId.make("environment-2"), threadId),
      ),
    ).toBeNull();
    expect(
      isRetractedTurnPresentationSuppressed({
        pendingRetraction: findPendingRetractionForThread(byRequestId, siblingThreadRef),
      }),
    ).toBe(false);
  });

  it("renders a newer turn normally when a held send dispatches", () => {
    const newTurn = presentation({
      projectedRetraction: { requestId, targetTurnId: retractedTurnId, status: "completed" },
      activeTurnId: nextTurnId,
    });

    expect(newTurn.retractedTurnSuppressed).toBe(false);
    expect(newTurn.phase).toBe("running");
    expect(newTurn.isWorking).toBe(true);
  });

  it("reports a held send as sending even while the retraction stays hidden", () => {
    const held = presentation({ heldSendPending: true });

    expect(held.retractedTurnSuppressed).toBe(true);
    expect(held.phase).toBe("ready");
    expect(held.isWorking).toBe(true);
  });
});
