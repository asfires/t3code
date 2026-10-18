import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it, vi } from "vite-plus/test";

import { loadToolRowCopyOutput, toolRowCopyTargets } from "./toolRowCopy";

const command = {
  id: TurnItemId.make("command"),
  threadId: ThreadId.make("thread"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed",
  title: null,
  startedAt: DateTime.makeUnsafe("2026-10-17T00:00:00Z"),
  completedAt: DateTime.makeUnsafe("2026-10-17T00:00:01Z"),
  updatedAt: DateTime.makeUnsafe("2026-10-17T00:00:01Z"),
  type: "command_execution",
  input: "  printf 'hello'  ",
} satisfies OrchestrationV2TurnItem;

describe("tool row copy targets", () => {
  it("offers only the command when a completed command has no output", () => {
    expect(toolRowCopyTargets(command)).toEqual({ command: "printf 'hello'", output: false });
  });

  it("offers output when it is omitted from the timeline or still streaming", () => {
    expect(toolRowCopyTargets({ ...command, outputOmitted: true }).output).toBe(true);
    expect(toolRowCopyTargets({ ...command, status: "running" }).output).toBe(true);
  });

  it("offers output alone for non-command tools", () => {
    expect(
      toolRowCopyTargets({
        ...command,
        type: "dynamic_tool",
        toolName: "Read",
        input: {},
        outputOmitted: true,
      }),
    ).toEqual({ command: null, output: true });
  });
});

describe("search tool copy targets", () => {
  it("offers search results as output", () => {
    expect(
      toolRowCopyTargets({
        ...command,
        type: "file_search",
        results: [{ fileName: "src/main.ts", line: 3, preview: "match" }],
      }).output,
    ).toBe(true);
    expect(
      toolRowCopyTargets({
        ...command,
        type: "web_search",
        results: [{ title: "Result", url: "https://example.com" }],
      }).output,
    ).toBe(true);
  });
});

describe("loading complete tool output for copying", () => {
  it("copies all available detail, including text before the displayed 64K tail", async () => {
    const output = "beginning\n" + "line\n".repeat(40_000) + "end\n";
    const stream = vi.fn(async () => ({ text: output.slice(-64_000), truncated: true }));
    expect(await loadToolRowCopyOutput(async () => ({ ...command, output }), stream)).toBe(output);
    expect(stream).not.toHaveBeenCalled();
  });

  it("extracts non-command output using the same text as the inspector", async () => {
    expect(
      await loadToolRowCopyOutput(async () => ({
        ...command,
        type: "dynamic_tool",
        toolName: "Read",
        input: {},
        output: {
          content: [
            { type: "text", text: "first\n" },
            { type: "text", text: "second" },
          ],
        },
      })),
    ).toBe("first\n\nsecond");
  });

  it("copies a complete live stream when the provider has not persisted output yet", async () => {
    expect(
      await loadToolRowCopyOutput(
        async () => ({ ...command, status: "running" }),
        async () => ({ text: "live\n", truncated: false }),
      ),
    ).toBe("live\n");
  });

  it("refuses a truncated live tail when full detail is not yet available", async () => {
    await expect(
      loadToolRowCopyOutput(
        async () => ({ ...command, status: "running" }),
        async () => ({ text: "tail", truncated: true }),
      ),
    ).rejects.toThrow("Full output is not available yet");
  });

  it("reports missing output without copying a tail or metadata", async () => {
    await expect(loadToolRowCopyOutput(async () => null)).rejects.toThrow("no longer available");
    await expect(loadToolRowCopyOutput(async () => command)).rejects.toThrow("No output available");
  });

  it("propagates detail request failures instead of silently copying a tail", async () => {
    const stream = vi.fn(async () => ({ text: "tail", truncated: true }));
    await expect(
      loadToolRowCopyOutput(async () => {
        throw new Error("Disconnected");
      }, stream),
    ).rejects.toThrow("Disconnected");
    expect(stream).not.toHaveBeenCalled();
  });
});
