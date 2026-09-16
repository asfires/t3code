import { projectQuestionToolInput } from "@t3tools/shared/toolActivity";
import type {
  OrchestrationEvent,
  OrchestrationThreadActivity,
  OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const UNAVAILABLE_RETAINED_BOUNDARY_DETAIL =
  /^Provider adapter validation failed \([^)]+\) in rollbackThreadTo: Provider history has \d+ turns, below retained boundary \d+\.$/;

function normalizeLegacyRetractionFailure(
  activity: OrchestrationThreadActivity,
): OrchestrationThreadActivity {
  const payload = asRecord(activity.payload);
  if (
    activity.kind !== "turn.retract.failed" ||
    !payload ||
    typeof payload.detail !== "string" ||
    !UNAVAILABLE_RETAINED_BOUNDARY_DETAIL.test(payload.detail)
  ) {
    return activity;
  }

  // Boundary failures emitted before stale Esc retractions became silent are
  // immutable event history. Normalize them at the wire boundary so every
  // projection rebuild keeps the compatibility behavior without rewriting
  // the event store or the persisted activity payload.
  return {
    ...activity,
    payload: {
      ...payload,
      silent: true,
    },
  };
}

export const MAX_PROJECTED_TOOL_RESULT_CHARS = 50_000;

const PROJECTED_TOOL_RESULT_TRUNCATION_MARKER = "…[truncated]";

type ValuePath = ReadonlyArray<string | number>;

function replaceStringAtPath(value: unknown, path: ValuePath, replacement: string): unknown {
  if (path.length === 0) {
    return replacement;
  }
  const [head, ...tail] = path;
  if (typeof head === "number" && Array.isArray(value)) {
    return value.map((entry, index) =>
      index === head ? replaceStringAtPath(entry, tail, replacement) : entry,
    );
  }
  const record = asRecord(value);
  if (typeof head === "string" && record) {
    return {
      ...record,
      [head]: replaceStringAtPath(record[head], tail, replacement),
    };
  }
  return value;
}

function findDominantTextPath(
  value: unknown,
  path: ValuePath = [],
): { readonly path: ValuePath; readonly text: string } | null {
  if (typeof value === "string") {
    return { path, text: value };
  }

  let dominant: { readonly path: ValuePath; readonly text: string } | null = null;
  const entries: ReadonlyArray<readonly [string | number, unknown]> = Array.isArray(value)
    ? value.map((entry, index) => [index, entry] as const)
    : Object.entries(asRecord(value) ?? {});
  for (const [key, entry] of entries) {
    const candidate = findDominantTextPath(entry, [...path, key]);
    if (candidate && (!dominant || candidate.text.length > dominant.text.length)) {
      dominant = candidate;
    }
  }
  return dominant;
}

function truncateTextInValue(
  value: unknown,
  path: ValuePath,
  text: string,
  serializedTotal: string,
): unknown | null {
  let keep = Math.max(
    0,
    text.length -
      (serializedTotal.length - MAX_PROJECTED_TOOL_RESULT_CHARS) -
      PROJECTED_TOOL_RESULT_TRUNCATION_MARKER.length,
  );
  let candidate = replaceStringAtPath(
    value,
    path,
    `${text.slice(0, keep)}${PROJECTED_TOOL_RESULT_TRUNCATION_MARKER}`,
  );

  let serializedCandidate: string | undefined;
  try {
    serializedCandidate = JSON.stringify(candidate);
  } catch {
    return null;
  }
  if (
    serializedCandidate !== undefined &&
    serializedCandidate.length <= MAX_PROJECTED_TOOL_RESULT_CHARS
  ) {
    return candidate;
  }

  const remainingOvershoot =
    (serializedCandidate?.length ?? MAX_PROJECTED_TOOL_RESULT_CHARS + 1) -
    MAX_PROJECTED_TOOL_RESULT_CHARS;
  keep = Math.max(0, keep - remainingOvershoot);
  candidate = replaceStringAtPath(
    value,
    path,
    `${text.slice(0, keep)}${PROJECTED_TOOL_RESULT_TRUNCATION_MARKER}`,
  );
  try {
    serializedCandidate = JSON.stringify(candidate);
  } catch {
    return null;
  }
  return serializedCandidate !== undefined &&
    serializedCandidate.length <= MAX_PROJECTED_TOOL_RESULT_CHARS
    ? candidate
    : null;
}

function truncateSerializedValue(serialized: string): string {
  const serializedTotal = JSON.stringify(serialized);
  const keep = Math.max(
    0,
    serialized.length -
      (serializedTotal.length - MAX_PROJECTED_TOOL_RESULT_CHARS) -
      PROJECTED_TOOL_RESULT_TRUNCATION_MARKER.length,
  );
  const candidate = `${serialized.slice(0, keep)}${PROJECTED_TOOL_RESULT_TRUNCATION_MARKER}`;
  return JSON.stringify(candidate).length <= MAX_PROJECTED_TOOL_RESULT_CHARS
    ? candidate
    : PROJECTED_TOOL_RESULT_TRUNCATION_MARKER;
}

function capProjectedToolValue(value: unknown): {
  readonly value: unknown;
  readonly truncated: boolean;
} {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { value, truncated: false };
  }
  if (serialized === undefined || serialized.length <= MAX_PROJECTED_TOOL_RESULT_CHARS) {
    return { value, truncated: false };
  }

  const dominant = findDominantTextPath(value);
  const truncatedValue = dominant
    ? truncateTextInValue(value, dominant.path, dominant.text, serialized)
    : null;
  if (truncatedValue !== null) {
    return { value: truncatedValue, truncated: true };
  }

  return {
    value: truncateSerializedValue(serialized),
    truncated: true,
  };
}

const OUTPUT_TOOL_FIELD_KEYS = new Set(["result", "rawOutput", "state", "aggregatedOutput"]);

function capToolFields(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  options: {
    readonly capKeys: ReadonlyArray<string>;
    readonly copyKeys: ReadonlyArray<string>;
  },
): boolean {
  let outputTruncated = false;
  for (const key of options.copyKeys) {
    if (key in source) {
      target[key] = source[key];
    }
  }
  for (const key of options.capKeys) {
    if (!(key in source)) {
      continue;
    }
    const capped = capProjectedToolValue(source[key]);
    target[key] = capped.value;
    if (OUTPUT_TOOL_FIELD_KEYS.has(key)) {
      outputTruncated ||= capped.truncated;
    }
  }
  return outputTruncated;
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown): void {
  const normalized = asTrimmedString(value);
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

function collectChangedFiles(
  value: unknown,
  target: string[],
  seen: Set<string>,
  depth: number,
): void {
  if (depth > 4 || target.length >= 12) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFiles(entry, target, seen, depth + 1);
      if (target.length >= 12) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  pushChangedFile(target, seen, record.path);
  pushChangedFile(target, seen, record.filePath);
  pushChangedFile(target, seen, record.relativePath);
  pushChangedFile(target, seen, record.filename);
  pushChangedFile(target, seen, record.newPath);
  pushChangedFile(target, seen, record.oldPath);

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "data",
    "changes",
    "files",
    "edits",
    "patch",
    "patches",
    "operations",
  ]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFiles(record[nestedKey], target, seen, depth + 1);
    if (target.length >= 12) {
      return;
    }
  }
}

function projectCommandData(data: Record<string, unknown>): {
  readonly item: Record<string, unknown> | undefined;
  readonly resultTruncated: boolean;
} {
  const item = asRecord(data.item);
  if (!item) {
    return { item: undefined, resultTruncated: false };
  }

  const projectedItem: Record<string, unknown> = {};
  const resultTruncated = capToolFields(item, projectedItem, {
    capKeys: ["toolName", "input", "result", "aggregatedOutput"],
    copyKeys: ["command", "exitCode", "status"],
  });

  return {
    item: Object.keys(projectedItem).length > 0 ? projectedItem : undefined,
    resultTruncated,
  };
}

function projectCommandValue(data: Record<string, unknown>): unknown {
  if (data.command !== undefined) {
    return data.command;
  }

  const input = asRecord(data.input);
  if (input?.command !== undefined) {
    return input.command;
  }

  const stateInput = asRecord(asRecord(data.state)?.input);
  if (stateInput?.command !== undefined) {
    return stateInput.command;
  }

  return undefined;
}

function projectViewedImagePath(data: Record<string, unknown>): string | undefined {
  const directPath = asTrimmedString(data.imagePath);
  if (directPath && isWorkspaceImagePreviewPath(directPath)) {
    return directPath;
  }

  const toolName = asTrimmedString(data.toolName)?.toLowerCase();
  if (toolName !== "read" && toolName !== "read file") {
    return undefined;
  }
  const input = asRecord(data.input);
  const inputPath = asTrimmedString(input?.file_path) ?? asTrimmedString(input?.path);
  return inputPath && isWorkspaceImagePreviewPath(inputPath) ? inputPath : undefined;
}

/**
 * Fields of an MCP tool-call item clients use for identity and presentation.
 * Result content is retained separately under the tool-output cap.
 */
const MCP_ITEM_KEPT_FIELDS = [
  "type",
  "id",
  "tool",
  "server",
  "status",
  "arguments",
  "appContext",
  "error",
  "durationMs",
] as const;

/**
 * Pulls renderable text out of an MCP tool result: either a Codex-style
 * `{content: [{type: "text", text}, ...]}` record or a raw Claude
 * `tool_result` block whose `content` is a string or block array.
 */
function extractMcpResultText(result: unknown): string | null {
  const record = asRecord(result);
  if (!record) {
    return typeof result === "string" ? result : null;
  }
  if (typeof record.content === "string") {
    return record.content;
  }
  if (Array.isArray(record.content)) {
    const texts: string[] = [];
    for (const entry of record.content) {
      const text = asRecord(entry)?.text;
      if (typeof text === "string" && text.trim().length > 0) {
        texts.push(text);
      }
    }
    if (texts.length > 0) {
      return texts.join("\n");
    }
  }
  return null;
}

/** Reuse the page URL already returned by preview tools before slimming their output. */
function projectPreviewToolMetadata(data: Record<string, unknown>, status: unknown) {
  const item = asRecord(data.item);
  const name = item ? `mcp__${item.server}__${item.tool}` : (data.toolName ?? data.tool);
  if (
    typeof name !== "string" ||
    !/^(?:mcp__)?(?:t3-code|t3_code|t3code)_{1,2}preview_(?:open|navigate|status|snapshot|click|type|press|scroll|resize|set_appearance|evaluate|wait_for|recording_start|recording_stop)$/.test(
      name,
    )
  )
    return {};
  const state = asRecord(data.state);
  const result = item?.result ?? data.result ?? state?.output;
  const record = asRecord(result);
  if (
    status === "failed" ||
    status === "declined" ||
    state?.status === "error" ||
    item?.error != null ||
    record?.isError === true ||
    record?.is_error === true
  )
    return {};

  let page = record;
  let output: unknown = result;
  for (let depth = 0; depth < 3; depth += 1) {
    if (page?.isError === true || page?.is_error === true) return {};
    const structured = asRecord(page?.structuredContent);
    if (structured) {
      page = structured;
      break;
    }
    const text = extractMcpResultText(output)?.slice(0, 2 * 1024 * 1024);
    if (!text) break;
    try {
      page = asRecord(JSON.parse(extractJsonObject(text)));
    } catch {
      // A truncated MCP envelope can still contain a complete first text block.
      const firstBlock = /^\s*\{\s*"content"\s*:\s*\[\s*/.exec(text);
      if (!firstBlock) return {};
      try {
        const block = asRecord(JSON.parse(extractJsonObject(text.slice(firstBlock[0].length))));
        page = block?.type === "text" ? { content: [block] } : null;
      } catch {
        return {};
      }
    }
    output = page;
  }
  const rawUrl = asTrimmedString(
    asRecord(page?.toolIcon)?.pageUrl ??
      (/preview_(?:open|navigate|status|snapshot)$/.test(name) ? page?.url : undefined),
  );
  if (!rawUrl || rawUrl.length > 4096) return {};
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return {};
    return { toolIcon: { _tag: "website", pageUrl: url.href } };
  } catch {
    return {};
  }
}

/**
 * MCP tool calls carry full tool results (`data.item.result` on Codex,
 * `data.result` on Claude/OpenCode) that used to bypass slimming entirely to
 * keep the expanded-row UI working. Keep the fields the UI actually renders
 * and summarize the result like regular tool output.
 */
function projectMcpToolCallData(data: Record<string, unknown>): Record<string, unknown> {
  const projectedData: Record<string, unknown> = {};
  let resultTruncated = false;

  const item = asRecord(data.item);
  if (item) {
    const projectedItem: Record<string, unknown> = {};
    resultTruncated ||= capToolFields(item, projectedItem, {
      capKeys: ["result"],
      copyKeys: MCP_ITEM_KEPT_FIELDS,
    });
    projectedData.item = projectedItem;
  }

  resultTruncated ||= capToolFields(data, projectedData, {
    capKeys: item
      ? ["toolName", "input", "rawOutput", "state"]
      : ["toolName", "input", "result", "rawOutput", "state"],
    copyKeys: ["tool", "toolCallId", "kind"],
  });

  const changedFiles: string[] = [];
  collectChangedFiles(data, changedFiles, new Set<string>(), 0);
  if (changedFiles.length > 0) {
    projectedData.files = changedFiles.map((path) => ({ path }));
  }
  if (resultTruncated) {
    projectedData.resultTruncated = true;
  }

  return projectedData;
}

/**
 * ACP providers deliver command output as a `content` array of text entries
 * rather than `rawOutput`. Join the text so the client can render it like any
 * other retained output; the caller caps it like every other output field.
 */
function joinAcpContentText(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const text = value
    .map((entryValue) => {
      const entry = asRecord(entryValue);
      const content = asRecord(entry?.content);
      return entry?.type === "content" && content?.type === "text"
        ? asTrimmedString(content.text)
        : null;
    })
    .filter((entry): entry is string => entry !== null)
    .join("\n");
  return text.length > 0 ? text : null;
}

/**
 * Removes activity payload fields that no current client reads while retaining
 * the full payload in persistence and the event store.
 */
export function projectActivityPayload(
  activity: OrchestrationThreadActivity,
): OrchestrationThreadActivity {
  const normalizedActivity = normalizeLegacyRetractionFailure(activity);
  const payload = asRecord(normalizedActivity.payload);
  const data = asRecord(payload?.data);
  if (!payload || !data) {
    return normalizedActivity;
  }

  const itemStatus = asRecord(data.item)?.status;
  const statusPayload =
    payload.status === "completed" && (itemStatus === "failed" || itemStatus === "declined")
      ? { ...payload, status: itemStatus }
      : payload;
  const projectedPayload = {
    ...projectPreviewToolMetadata(data, statusPayload.status),
    ...statusPayload,
  };
  const questionInput = projectQuestionToolInput(data, payload.title);

  if (payload.itemType === "mcp_tool_call") {
    return {
      ...normalizedActivity,
      payload: {
        ...projectedPayload,
        data: { ...projectMcpToolCallData(data), ...questionInput },
      },
    };
  }

  const projectedData: Record<string, unknown> = { ...questionInput };
  let resultTruncated = false;
  const projectedCommandData = projectCommandData(data);
  const item = projectedCommandData.item;
  if (item) {
    projectedData.item = item;
  }
  resultTruncated ||= projectedCommandData.resultTruncated;
  const itemResultWasRetained = item !== undefined && "result" in item;
  resultTruncated ||= capToolFields(data, projectedData, {
    capKeys: itemResultWasRetained
      ? ["toolName", "input", "rawOutput", "state"]
      : ["toolName", "input", "result", "rawOutput", "state"],
    copyKeys: ["command", "tool", "toolCallId", "kind"],
  });
  const command = projectCommandValue(data);
  if (command !== undefined) {
    projectedData.command = command;
  }
  const imagePath = projectViewedImagePath(data);
  if (imagePath) {
    projectedData.imagePath = imagePath;
  }

  const changedFiles: string[] = [];
  collectChangedFiles(data, changedFiles, new Set<string>(), 0);
  if (changedFiles.length > 0) {
    // Both clients discover file names by walking objects with path-like keys.
    projectedData.files = changedFiles.map((path) => ({ path }));
  }

  if (!("rawOutput" in projectedData)) {
    const acpText = joinAcpContentText(data.content);
    if (acpText !== null) {
      const capped = capProjectedToolValue({ content: acpText });
      projectedData.rawOutput = capped.value;
      resultTruncated ||= capped.truncated;
    }
  }
  if ("toolName" in data) {
    projectedData.toolName = data.toolName;
  }

  if (resultTruncated) {
    projectedData.resultTruncated = true;
  }

  return {
    ...normalizedActivity,
    payload: {
      ...projectedPayload,
      data: projectedData,
    },
  };
}

/**
 * Matches the validity rule in the web client's
 * `deriveLatestContextWindowSnapshot`: rows without a finite, non-negative
 * `usedTokens` are skipped during its backward walk, so they must not shadow
 * an earlier resolvable row here.
 */
function isResolvableContextWindowActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "context-window.updated") {
    return false;
  }
  const payload = asRecord(activity.payload);
  const usedTokens = payload?.usedTokens;
  return typeof usedTokens === "number" && Number.isFinite(usedTokens) && usedTokens >= 0;
}

/**
 * Drops all but the last resolvable context-window activity per turn from a
 * snapshot. Clients only ever read the latest usage value (walking the array
 * backwards), so shipping the full history — often thousands of rows on long
 * threads — buys nothing. Retention is per turn rather than per thread because
 * a live `thread.reverted` makes the client discard whole turns; keeping each
 * turn's latest row means the meter can still resolve a value from the turns
 * that survive. Malformed rows pass through untouched rather than shadowing a
 * valid earlier row. Live `thread.activity-appended` events are untouched:
 * newer updates still stream through and supersede the retained rows on the
 * client.
 */
function dropStaleContextWindowActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const latestIndexByTurn = new Map<string | null, number>();
  for (let index = 0; index < activities.length; index += 1) {
    if (isResolvableContextWindowActivity(activities[index]!)) {
      latestIndexByTurn.set(activities[index]!.turnId, index);
    }
  }
  if (latestIndexByTurn.size === 0) {
    return activities;
  }
  return activities.filter(
    (activity, index) =>
      !isResolvableContextWindowActivity(activity) ||
      latestIndexByTurn.get(activity.turnId) === index,
  );
}

/**
 * Identity used to retain only the newest lifecycle row for each call in a
 * thread snapshot. Prefer the runtime item id, then the legacy nested id, and
 * finally the itemType/title/detail triple. Rows without any identity remain
 * untouched.
 */
function toolLifecycleIdentity(activity: OrchestrationThreadActivity): string | null {
  const payload = asRecord(activity.payload);
  if (!payload) {
    return null;
  }

  const toolCallId =
    asTrimmedString(payload.toolCallId) ?? asTrimmedString(asRecord(payload.data)?.toolCallId);
  if (toolCallId) {
    return `id:${toolCallId}`;
  }

  const itemType = asTrimmedString(payload.itemType) ?? "";
  // Mirrors the clients' `normalizeCompactToolLabel`: a completion's title may
  // gain a trailing "complete"/"completed" the in-flight updates lack.
  const label = (asTrimmedString(payload.title) ?? activity.summary)
    .replace(/\s+(?:complete|completed)\s*$/iu, "")
    .trim();
  const detail = asTrimmedString(payload.detail) ?? "";
  if (itemType.length === 0 && label.length === 0 && detail.length === 0) {
    return null;
  }
  return [itemType, label, detail].join("\u001f");
}

/**
 * Drops `tool.updated` rows a `tool.completed` row already supersedes. An
 * update is the in-flight snapshot of a call; once the call completes, the
 * completion carries the final state and the clients fold every matching
 * update into it, so shipping the updates buys nothing — 47k such rows exist
 * in one real database, and a single thread carries 2,291 of them totalling
 * ~1MB post-slimming.
 *
 * Matching is per turn for the same reason `dropStaleContextWindowActivities`
 * retains per turn: a live `thread.reverted` makes the client discard whole
 * turns, so a completion in a different turn could vanish and leave the
 * dropped update unrepresented. The completion must also come *after* the
 * update within the turn — a later update belongs to a subsequent call that
 * reuses the same identity and is still in flight. Rows without a lifecycle
 * identity pass through, matching the clients, which never collapse them.
 * Deliberate divergence from client collapse: clients fold only *adjacent*
 * lifecycle rows, so a superseded update separated from its completion by an
 * interleaved parallel call renders as its own row today, and this drop
 * removes it. Measured against a real database, that affects 1.5% of dropped
 * rows (553 of 36,581), all pure in-flight state whose final result the
 * retained completion still shows. Dropping them is intentional; matching
 * adjacency server-side would forfeit most of the win for parallel-heavy
 * threads, which are exactly the heavy ones. Superseding completions always
 * carry a payload superset of their updates (verified across all 49,515
 * update rows: zero dropped rows held a client-merged field — detail, title,
 * command, item, kind, files — their completion lacked), so no expanded-row
 * content is lost.
 */
function dropSupersededToolUpdatedActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const completionIndicesByKey = new Map<string, number[]>();
  for (let index = 0; index < activities.length; index += 1) {
    const activity = activities[index]!;
    if (activity.kind !== "tool.completed") {
      continue;
    }
    const identity = toolLifecycleIdentity(activity);
    if (!identity) {
      continue;
    }
    const key = `${activity.turnId ?? ""}\u0000${identity}`;
    const indices = completionIndicesByKey.get(key);
    if (indices) {
      indices.push(index);
    } else {
      completionIndicesByKey.set(key, [index]);
    }
  }
  if (completionIndicesByKey.size === 0) {
    return activities;
  }

  return activities.filter((activity, index) => {
    if (activity.kind !== "tool.updated") {
      return true;
    }
    const identity = toolLifecycleIdentity(activity);
    if (!identity) {
      return true;
    }
    const indices = completionIndicesByKey.get(`${activity.turnId ?? ""}\u0000${identity}`);
    return !indices?.some((completionIndex) => completionIndex > index);
  });
}

export function projectThreadDetailSnapshot(
  snapshot: OrchestrationThreadDetailSnapshot,
): OrchestrationThreadDetailSnapshot {
  return {
    ...snapshot,
    thread: {
      ...snapshot.thread,
      activities: dropSupersededToolUpdatedActivities(
        dropStaleContextWindowActivities(snapshot.thread.activities),
      ).map(projectActivityPayload),
    },
  };
}

export function projectActivityEvent(event: OrchestrationEvent): OrchestrationEvent {
  if (event.type !== "thread.activity-appended") {
    return event;
  }
  return {
    ...event,
    payload: {
      ...event.payload,
      activity: projectActivityPayload(event.payload.activity),
    },
  };
}
