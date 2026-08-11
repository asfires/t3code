// @effect-diagnostics nodeBuiltinImport:off cryptoRandomUUID:off globalFetch:off globalDate:off globalConsole:off globalTimers:off - Standalone black-box probe intentionally uses host APIs around the real Effect RPC client.
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  CommandId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WsRpcGroup,
} from "@t3tools/contracts";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

type Provider = "claudeAgent" | "codex";
type Timing = "double-pop" | "immediate" | "long-response" | "mid-thinking";

const [baseDir, httpOrigin, pairingCredential, providerArg = "codex", timingArg = "immediate"] =
  process.argv.slice(2);
if (!baseDir || !httpOrigin || !pairingCredential) {
  throw new Error(
    "usage: node apps/server/scripts/turn-retraction-repro.ts <base-dir> <http-origin> <pairing-credential> [codex|claudeAgent] [immediate|mid-thinking|long-response|double-pop]",
  );
}
if (providerArg !== "codex" && providerArg !== "claudeAgent") {
  throw new Error(`unsupported provider '${providerArg}'`);
}
if (
  timingArg !== "immediate" &&
  timingArg !== "mid-thinking" &&
  timingArg !== "long-response" &&
  timingArg !== "double-pop"
) {
  throw new Error(`unsupported timing '${timingArg}'`);
}

const provider: Provider = providerArg;
const timing: Timing = timingArg;
const delayMs = timing === "mid-thinking" ? 250 : timing === "long-response" ? 1_000 : 0;
const maxRetractionCompletionMs = 20_000;
const maxDoublePopCompletionMs = 5_000;
const doublePopIterations = 4;
const suffix = crypto.randomUUID();
const projectId = ProjectId.make(`repro-project-${suffix}`);
const threadId = ThreadId.make(`repro-thread-${suffix}`);
const baselineMessageId = MessageId.make(`repro-baseline-message-${suffix}`);
const naturalControlMessageId = MessageId.make(`repro-natural-control-message-${suffix}`);
const setupRetractionMessageId = MessageId.make(`repro-setup-retraction-message-${suffix}`);
const retractedMessageId = MessageId.make(`repro-retracted-message-${suffix}`);
const interrogationMessageId = MessageId.make(`repro-interrogation-message-${suffix}`);
const setupRetractionRequestId = CommandId.make(`repro-setup-retract-${suffix}`);
const retractionRequestId = CommandId.make(`repro-retract-${suffix}`);
const workspaceRoot = `${baseDir}/workspace-${suffix}`;
const retainedMarker = `KEPT_MARKER_${suffix}`;
const retractedMarker = `REMOVED_MARKER_${suffix}`;
const setupRetractionMarker = `SETUP_REMOVED_MARKER_${suffix}`;
const hostNowIso = () => new Date().toISOString();
const hostNowMs = () => Date.now();
const stringifyJson = (value: unknown) => JSON.stringify(value);
const modelSelection = {
  instanceId: ProviderInstanceId.make(provider),
  model: provider === "codex" ? "gpt-5.4" : "claude-sonnet-4-6",
};

mkdirSync(workspaceRoot, { recursive: true });
writeFileSync(`${workspaceRoot}/README.md`, "# Turn retraction repro\n");
execFileSync("git", ["init", "--quiet"], { cwd: workspaceRoot });
execFileSync("git", ["config", "user.name", "T3 Retraction Repro"], { cwd: workspaceRoot });
execFileSync("git", ["config", "user.email", "repro@t3.local"], { cwd: workspaceRoot });
execFileSync("git", ["add", "README.md"], { cwd: workspaceRoot });
execFileSync("git", ["commit", "--allow-empty", "--quiet", "-m", "repro baseline"], {
  cwd: workspaceRoot,
});

const bootstrapResponse = await fetch(`${httpOrigin}/api/auth/browser-session`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ credential: pairingCredential }),
});
if (!bootstrapResponse.ok) {
  throw new Error(`pairing credential exchange failed (${bootstrapResponse.status})`);
}
const sessionCookie = bootstrapResponse.headers.getSetCookie()[0]?.split(";", 1)[0];
if (!sessionCookie) throw new Error("pairing credential exchange returned no session cookie");

const database = new DatabaseSync(`${baseDir}/userdata/state.sqlite`, { readOnly: true });
const queryOne = <T>(sql: string, ...params: ReadonlyArray<string>): T | undefined =>
  database.prepare(sql).get(...params) as T | undefined;
const waitFor = async <T>(
  label: string,
  read: () => T | undefined,
  complete: (value: T) => boolean,
  timeoutMs = 120_000,
): Promise<T> => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = read();
    if (value !== undefined && complete(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(read() ?? null)}`);
};
const readTurn = (messageId: MessageId) =>
  queryOne<{
    state: string;
    turnId: string | null;
    checkpointTurnCount: number | null;
    checkpointStatus: string | null;
  }>(
    `SELECT state, turn_id AS turnId, checkpoint_turn_count AS checkpointTurnCount,
            checkpoint_status AS checkpointStatus
     FROM projection_turns
     WHERE thread_id = ? AND pending_message_id = ?
     ORDER BY row_id DESC LIMIT 1`,
    threadId,
    messageId,
  );
const readSession = () =>
  queryOne<{ status: string; activeTurnId: string | null }>(
    `SELECT status, active_turn_id AS activeTurnId
     FROM projection_thread_sessions WHERE thread_id = ?`,
    threadId,
  );
const readProviderSendClaimed = (messageId: MessageId) =>
  queryOne<{ claimedAt: string }>(
    `SELECT claimed_at AS claimedAt FROM provider_turn_send_claims
     WHERE thread_id = ? AND message_id = ?`,
    threadId,
    messageId,
  );
const readRetraction = (requestId = retractionRequestId) =>
  queryOne<{
    status: string;
    providerSendState: string;
    targetTurnId: string | null;
    baselineTurnCount: number;
    completedAt: string | null;
    failedAt: string | null;
  }>(
    `SELECT status, provider_send_state AS providerSendState,
            target_turn_id AS targetTurnId, baseline_turn_count AS baselineTurnCount,
            completed_at AS completedAt, failed_at AS failedAt
     FROM projection_turn_retractions WHERE request_id = ?`,
    requestId,
  );
const readAssistantReply = (messageId: MessageId) =>
  queryOne<{ text: string }>(
    `SELECT messages.text
     FROM projection_turns AS turns
     JOIN projection_thread_messages AS messages
       ON messages.message_id = turns.assistant_message_id
     WHERE turns.thread_id = ? AND turns.pending_message_id = ?
     ORDER BY turns.row_id DESC LIMIT 1`,
    threadId,
    messageId,
  )?.text;

const wsUrl = `${httpOrigin.replace(/^http/, "ws")}/ws`;
const socketConstructorLayer = Layer.succeed(
  Socket.WebSocketConstructor,
  (url, protocols) =>
    new NodeSocket.NodeWS.WebSocket(url, protocols, {
      headers: { cookie: sessionCookie },
    }) as unknown as globalThis.WebSocket,
);
const protocolLayer = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(Socket.layerWebSocket(wsUrl).pipe(Layer.provide(socketConstructorLayer))),
  Layer.provide(RpcSerialization.layerJson),
);
const makeClient = RpcClient.make(WsRpcGroup);

const run = Effect.gen(function* () {
  const client = yield* makeClient;
  const dispatchTurn = (messageId: MessageId, text: string) =>
    client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
      type: "thread.turn.start",
      commandId: CommandId.make(`repro-start-${messageId}`),
      threadId,
      message: {
        messageId,
        role: "user",
        text,
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: hostNowIso(),
    });

  const createdAt = hostNowIso();
  yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
    type: "project.create",
    commandId: CommandId.make(`repro-create-project-${suffix}`),
    projectId,
    title: `Retraction repro ${provider} ${timing}`,
    workspaceRoot,
    createWorkspaceRootIfMissing: true,
    defaultModelSelection: modelSelection,
    createdAt,
  });
  yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
    type: "thread.create",
    commandId: CommandId.make(`repro-create-thread-${suffix}`),
    threadId,
    projectId,
    title: `Retraction repro ${provider} ${timing}`,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt,
  });

  yield* dispatchTurn(
    baselineMessageId,
    `Remember this exact token: ${retainedMarker}. Reply with exactly BASELINE_ACK.`,
  );
  const baselineTurn = yield* Effect.promise(() =>
    waitFor(
      "completed baseline turn and checkpoint",
      () => readTurn(baselineMessageId),
      (turn) =>
        turn.state === "completed" &&
        turn.checkpointTurnCount === 1 &&
        turn.checkpointStatus === "ready",
    ),
  );

  type RetractionRow = NonNullable<ReturnType<typeof readRetraction>>;
  const doublePopAttempts: Array<{
    readonly iteration: number;
    readonly phase: "first" | "resend";
    readonly marker: string;
    readonly delayMs: number;
    readonly sessionStatusAtRetraction: string;
    readonly requestToCompleteMs: number;
    readonly sendToCompleteMs: number;
  }> = [];
  let retraction: RetractionRow | undefined;
  let naturalCompletionMs: number | null = null;
  let retractionCompletionMs: number | null = null;
  let sessionStatusAtRetraction = "n/a";

  if (timing === "double-pop") {
    for (let iteration = 1; iteration <= doublePopIterations; iteration += 1) {
      for (const phase of ["first", "resend"] as const) {
        const phaseDelayMs = phase === "first" ? 1_000 : 300;
        const marker = `DOUBLE_REMOVED_MARKER_${suffix}_${iteration}_${phase}`;
        const messageId = MessageId.make(`repro-double-${suffix}-${iteration}-${phase}`);
        const requestId = CommandId.make(`repro-double-retract-${suffix}-${iteration}-${phase}`);
        const sentAtMs = hostNowMs();
        yield* dispatchTurn(
          messageId,
          `Remember this exact token: ${marker}. Then count from 1 to 400, one number per line, no other text.`,
        );
        yield* Effect.promise(() =>
          waitFor(
            `double-pop ${iteration} ${phase} turn start`,
            () => ({ session: readSession(), turn: readTurn(messageId) }),
            (value) =>
              value.session?.status === "running" &&
              value.session.activeTurnId !== null &&
              value.turn?.state === "running" &&
              value.turn.turnId === value.session.activeTurnId,
          ),
        );
        yield* Effect.sleep(`${phaseDelayMs} millis`);
        const beforeRetraction = yield* Effect.sync(() => ({
          session: readSession(),
          turn: readTurn(messageId),
        }));
        if (
          beforeRetraction.session?.status !== "running" ||
          beforeRetraction.turn?.state !== "running"
        ) {
          throw new Error(
            `double-pop ${iteration} ${phase} completed before retraction: ${stringifyJson(beforeRetraction)}`,
          );
        }
        const requestedAtMs = hostNowMs();
        yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
          type: "thread.turn.retract",
          commandId: requestId,
          threadId,
          messageId,
          createdAt: hostNowIso(),
        });
        const attemptRetraction = yield* Effect.promise(() =>
          waitFor(
            `double-pop ${iteration} ${phase} retraction`,
            () => readRetraction(requestId),
            (row) => row.status === "completed" || row.status === "failed",
          ),
        );
        const completedAtMs = hostNowMs();
        const requestToCompleteMs = completedAtMs - requestedAtMs;
        const sendToCompleteMs = completedAtMs - sentAtMs;
        if (
          attemptRetraction.status !== "completed" ||
          attemptRetraction.providerSendState !== "claimed" ||
          attemptRetraction.baselineTurnCount !== 1
        ) {
          throw new Error(
            `double-pop ${iteration} ${phase} rollback failed: ${stringifyJson(attemptRetraction)}`,
          );
        }
        if (
          requestToCompleteMs > maxDoublePopCompletionMs ||
          sendToCompleteMs > maxDoublePopCompletionMs
        ) {
          throw new Error(
            `double-pop ${iteration} ${phase} timing gate failed: requestToCompleteMs=${requestToCompleteMs} sendToCompleteMs=${sendToCompleteMs} maxDoublePopCompletionMs=${maxDoublePopCompletionMs}`,
          );
        }
        doublePopAttempts.push({
          iteration,
          phase,
          marker,
          delayMs: phaseDelayMs,
          sessionStatusAtRetraction: beforeRetraction.session.status,
          requestToCompleteMs,
          sendToCompleteMs,
        });
        retraction = attemptRetraction;
      }
    }
  } else {
    if (timing === "immediate") {
      yield* dispatchTurn(
        setupRetractionMessageId,
        `Remember this exact token: ${setupRetractionMarker}. Use the shell to run sleep 20, then reply with exactly SETUP_ACK.`,
      );
      yield* Effect.promise(() =>
        waitFor(
          "provider to start setup retraction turn",
          () => ({ session: readSession(), turn: readTurn(setupRetractionMessageId) }),
          (value) =>
            value.session?.status === "running" &&
            value.session.activeTurnId !== null &&
            value.turn?.turnId === value.session.activeTurnId,
        ),
      );
      yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
        type: "thread.turn.retract",
        commandId: setupRetractionRequestId,
        threadId,
        messageId: setupRetractionMessageId,
        createdAt: hostNowIso(),
      });
      const setupRetraction = yield* Effect.promise(() =>
        waitFor(
          "completed setup retraction",
          () => readRetraction(setupRetractionRequestId),
          (row) => row.status === "completed" || row.status === "failed",
        ),
      );
      if (setupRetraction.status !== "completed") {
        throw new Error(`setup retraction failed: ${stringifyJson(setupRetraction)}`);
      }
    }

    let expectedRetractionBaselineTurnCount = 1;
    if (timing === "long-response") {
      const naturalStartedAtMs = hostNowMs();
      yield* dispatchTurn(
        naturalControlMessageId,
        "Count from 1 to 400, one number per line, no other text.",
      );
      yield* Effect.promise(() =>
        waitFor(
          "natural long-response control and checkpoint",
          () => readTurn(naturalControlMessageId),
          (turn) =>
            turn.state === "completed" &&
            turn.checkpointTurnCount === 2 &&
            turn.checkpointStatus === "ready",
        ),
      );
      naturalCompletionMs = hostNowMs() - naturalStartedAtMs;
      expectedRetractionBaselineTurnCount = 2;
    }

    yield* dispatchTurn(
      retractedMessageId,
      timing === "mid-thinking"
        ? `Remember this exact token: ${retractedMarker}. Use the shell to run sleep 20, then reply with exactly RETRACTED_ACK.`
        : timing === "long-response"
          ? `Remember this exact token: ${retractedMarker}. Then count from 1 to 400, one number per line, no other text.`
          : `Remember this exact token: ${retractedMarker}. Reply with exactly RETRACTED_ACK.`,
    );
    if (timing === "immediate") {
      const claimedSend = yield* Effect.promise(() =>
        waitFor(
          "claimed provider send before immediate retraction",
          () => ({ claim: readProviderSendClaimed(retractedMessageId), session: readSession() }),
          (value) =>
            value.claim !== undefined &&
            (value.session?.status === "starting" || value.session?.status === "running"),
        ),
      );
      sessionStatusAtRetraction = claimedSend.session?.status ?? "missing";
    } else {
      const startedTurn = yield* Effect.promise(() =>
        waitFor(
          "provider to start the retractable turn",
          () => ({ session: readSession(), turn: readTurn(retractedMessageId) }),
          (value) =>
            value.session?.status === "running" &&
            value.session.activeTurnId !== null &&
            value.turn?.turnId === value.session.activeTurnId,
        ),
      );
      sessionStatusAtRetraction = startedTurn.session?.status ?? "missing";
    }
    if (delayMs > 0) yield* Effect.sleep(`${delayMs} millis`);
    const beforeRetraction = yield* Effect.sync(() => ({
      session: readSession(),
      turn: readTurn(retractedMessageId),
    }));
    if (
      timing === "long-response" &&
      (beforeRetraction.session?.status !== "running" || beforeRetraction.turn?.state !== "running")
    ) {
      throw new Error(
        `long response completed before retraction was requested: ${stringifyJson(beforeRetraction)}`,
      );
    }
    const retractionRequestedAtMs = hostNowMs();
    yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
      type: "thread.turn.retract",
      commandId: retractionRequestId,
      threadId,
      messageId: retractedMessageId,
      createdAt: hostNowIso(),
    });
    retraction = yield* Effect.promise(() =>
      waitFor(
        "terminal retraction",
        readRetraction,
        (row) => row.status === "completed" || row.status === "failed",
      ),
    );
    retractionCompletionMs = hostNowMs() - retractionRequestedAtMs;
    if (retraction.status !== "completed") {
      throw new Error(`retraction failed: ${stringifyJson(retraction)}`);
    }
    if (retraction.providerSendState !== "claimed") {
      throw new Error(
        `retraction did not exercise provider rollback: ${stringifyJson(retraction)}`,
      );
    }
    if (retraction.baselineTurnCount !== expectedRetractionBaselineTurnCount) {
      throw new Error(
        `unexpected rollback boundary: expected ${expectedRetractionBaselineTurnCount}, got ${retraction.baselineTurnCount}`,
      );
    }
    if (
      timing === "long-response" &&
      (naturalCompletionMs === null ||
        retractionCompletionMs >= maxRetractionCompletionMs ||
        retractionCompletionMs >= naturalCompletionMs)
    ) {
      throw new Error(
        `long-response timing gate failed: retractionCompletionMs=${retractionCompletionMs} naturalCompletionMs=${naturalCompletionMs} maxRetractionCompletionMs=${maxRetractionCompletionMs}`,
      );
    }
  }

  if (!retraction) {
    throw new Error("scenario completed without a retraction result");
  }

  yield* dispatchTurn(
    interrogationMessageId,
    "List every user message I have sent in this conversation before this one, verbatim.",
  );
  const interrogationTurn = yield* Effect.promise(() =>
    waitFor(
      "completed interrogation turn",
      () => readTurn(interrogationMessageId),
      (turn) => turn.state === "completed",
    ),
  );
  const reply = yield* Effect.promise(() =>
    waitFor(
      "interrogation assistant reply",
      () => readAssistantReply(interrogationMessageId),
      (text) => text.length > 0,
    ),
  );

  return {
    baselineTurn,
    retraction,
    interrogationTurn,
    reply,
    naturalCompletionMs,
    retractionCompletionMs,
    sessionStatusAtRetraction,
    doublePopAttempts,
  };
}).pipe(Effect.provide(protocolLayer));

try {
  const result = await Effect.runPromise(Effect.scoped(run));
  const retractedMarkerStatus = result.reply.includes(retractedMarker) ? "PRESENT" : "ABSENT";
  const retainedMarkerStatus = result.reply.includes(retainedMarker) ? "PRESENT" : "ABSENT";
  const setupRetractionMarkerStatus = result.reply.includes(setupRetractionMarker)
    ? "PRESENT"
    : "ABSENT";
  console.log(
    `scenario provider=${provider} timing=${timing} sessionAtRetraction=${result.sessionStatusAtRetraction} delayMs=${delayMs} threadId=${threadId}`,
  );
  console.log(
    `rollback baselineTurnCount=${result.retraction.baselineTurnCount} providerSendState=${result.retraction.providerSendState} targetTurnId=${result.retraction.targetTurnId}`,
  );
  console.log(
    `timings retractionCompletionMs=${result.retractionCompletionMs} naturalCompletionMs=${result.naturalCompletionMs ?? "n/a"} maxRetractionCompletionMs=${maxRetractionCompletionMs}`,
  );
  if (timing === "double-pop") {
    for (const attempt of result.doublePopAttempts) {
      const markerStatus = result.reply.includes(attempt.marker) ? "PRESENT" : "ABSENT";
      console.log(
        `doublePop iteration=${attempt.iteration} phase=${attempt.phase} sessionAtRetraction=${attempt.sessionStatusAtRetraction} delayMs=${attempt.delayMs} requestToCompleteMs=${attempt.requestToCompleteMs} sendToCompleteMs=${attempt.sendToCompleteMs} marker=${attempt.marker} status=${markerStatus}`,
      );
    }
    console.log(
      `doublePopSummary attempts=${result.doublePopAttempts.length} maxRequestToCompleteMs=${Math.max(...result.doublePopAttempts.map((attempt) => attempt.requestToCompleteMs))} maxSendToCompleteMs=${Math.max(...result.doublePopAttempts.map((attempt) => attempt.sendToCompleteMs))} maxAllowedMs=${maxDoublePopCompletionMs}`,
    );
  } else {
    console.log(`retractedMarker=${retractedMarker} status=${retractedMarkerStatus}`);
  }
  if (timing === "immediate") {
    console.log(
      `setupRetractedMarker=${setupRetractionMarker} status=${setupRetractionMarkerStatus}`,
    );
  }
  console.log(`retainedMarker=${retainedMarker} status=${retainedMarkerStatus}`);
  console.log(`interrogationReplyChars=${result.reply.length}`);
  if (
    (timing !== "double-pop" && retractedMarkerStatus !== "ABSENT") ||
    result.doublePopAttempts.some((attempt) => result.reply.includes(attempt.marker)) ||
    retainedMarkerStatus !== "PRESENT" ||
    (timing === "immediate" && setupRetractionMarkerStatus !== "ABSENT")
  ) {
    throw new Error(
      `model-context gate failed: retracted=${retractedMarkerStatus} setupRetracted=${setupRetractionMarkerStatus} retained=${retainedMarkerStatus}`,
    );
  }
  console.log("gate=PASS");
} finally {
  database.close();
}
