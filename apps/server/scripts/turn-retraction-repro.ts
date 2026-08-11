// @effect-diagnostics nodeBuiltinImport:off cryptoRandomUUID:off globalFetch:off globalDate:off globalDateInEffect:off globalConsole:off globalTimers:off - Standalone black-box probe intentionally uses host APIs around the real Effect RPC client.
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
import { DatabaseSync } from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

const [baseDir, httpOrigin, pairingCredential, timing = "immediate"] = process.argv.slice(2);
if (!baseDir || !httpOrigin || !pairingCredential) {
  throw new Error(
    "usage: node apps/server/scripts/turn-retraction-repro.ts <base-dir> <http-origin> <pairing-credential> [immediate|mid-thinking]",
  );
}

const delayMs = timing === "mid-thinking" ? 2_000 : 0;
const suffix = crypto.randomUUID();
const projectId = ProjectId.make(`repro-project-${suffix}`);
const threadId = ThreadId.make(`repro-thread-${suffix}`);
const messageId = MessageId.make(`repro-message-${suffix}`);
const retractionRequestId = CommandId.make(`repro-retract-${suffix}`);
const workspaceRoot = `${baseDir}/workspace-${suffix}`;

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
  const createdAt = new Date().toISOString();
  yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
    type: "project.create",
    commandId: CommandId.make(`repro-create-project-${suffix}`),
    projectId,
    title: `Retraction repro ${timing}`,
    workspaceRoot,
    createWorkspaceRootIfMissing: true,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    createdAt,
  });
  yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
    type: "thread.create",
    commandId: CommandId.make(`repro-create-thread-${suffix}`),
    threadId,
    projectId,
    title: `Retraction repro ${timing}`,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt,
  });
  yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
    type: "thread.turn.start",
    commandId: CommandId.make(`repro-start-${suffix}`),
    threadId,
    message: {
      messageId,
      role: "user",
      text:
        timing === "mid-thinking"
          ? "Use the shell to run sleep 20, then reply with exactly done."
          : "Reply with exactly done.",
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: new Date().toISOString(),
  });
  if (delayMs > 0) yield* Effect.sleep(`${delayMs} millis`);
  yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
    type: "thread.turn.retract",
    commandId: retractionRequestId,
    threadId,
    messageId,
    createdAt: new Date().toISOString(),
  });
}).pipe(Effect.provide(protocolLayer));

await Effect.runPromise(Effect.scoped(run));

const database = new DatabaseSync(`${baseDir}/userdata/state.sqlite`, { readOnly: true });
const readRow = () =>
  database
    .prepare(
      `SELECT status, provider_send_state AS providerSendState,
              target_turn_id AS targetTurnId, completed_at AS completedAt, failed_at AS failedAt
       FROM projection_turn_retractions WHERE request_id = ?`,
    )
    .get(retractionRequestId);
const readSession = () =>
  database
    .prepare(
      `SELECT status, active_turn_id AS activeTurnId, updated_at AS updatedAt
       FROM projection_thread_sessions WHERE thread_id = ?`,
    )
    .get(threadId);

console.log(`scenario=${timing} delayMs=${delayMs} threadId=${threadId}`);
for (const elapsedMs of [0, 2_000, 35_000]) {
  if (elapsedMs > 0)
    await new Promise((resolve) => setTimeout(resolve, elapsedMs === 2_000 ? 2_000 : 33_000));
  console.log(
    JSON.stringify({ elapsedMs, retraction: readRow() ?? null, session: readSession() ?? null }),
  );
  const row = readRow() as { status?: string } | undefined;
  if (row?.status === "completed" || row?.status === "failed") break;
}

const events = database
  .prepare(
    `SELECT sequence, event_type AS eventType, payload_json AS payload
     FROM orchestration_events WHERE stream_id = ? ORDER BY sequence`,
  )
  .all(threadId)
  .map((row) => ({
    sequence: row.sequence,
    eventType: row.eventType,
    payload: JSON.parse(String(row.payload)),
  }));
console.log(JSON.stringify({ terminalRetraction: readRow() ?? null, events }, null, 2));
database.close();
