import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import { projectActivityPayload } from "./ActivityPayloadProjection.ts";

function activity(payload: Record<string, unknown>): OrchestrationThreadActivity {
  return {
    id: "activity-1",
    tone: "tool",
    kind: "tool.completed",
    summary: "Tool",
    payload,
    turnId: null,
    createdAt: "2026-08-01T10:00:00.000Z",
  } as unknown as OrchestrationThreadActivity;
}

/**
 * Wire-survival regression: the slimming pass rewrites payload.data but must
 * never strip the top-level per-agent fields the subagent fold depends on.
 * If slimming ever moves to an allowlist over the whole payload, these
 * assertions are the tripwire.
 */
describe("projectActivityPayload", () => {
  it("preserves tool attribution (agentId/parentToolUseId) through data slimming", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        agentId: "task-123",
        parentToolUseId: "toolu_abc",
        data: {
          toolName: "Bash",
          input: { command: "ls" },
          command: "ls",
          rawOutput: { content: "x".repeat(10) },
          somethingClientNeverReads: { big: "blob" },
        },
      }),
    );
    const payload = projected.payload as Record<string, unknown>;
    expect(payload.agentId).toBe("task-123");
    expect(payload.parentToolUseId).toBe("toolu_abc");
    // Slimming itself still applies to data.
    const data = payload.data as Record<string, unknown>;
    expect(data.somethingClientNeverReads).toBeUndefined();
  });

  it("retains Codex command output under the projection cap", () => {
    const aggregatedOutput = `hello from codex\n${"x".repeat(5000)}`;
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          item: {
            command: "/bin/zsh -lc 'printf hello'",
            aggregatedOutput,
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.item).toEqual({
      command: "/bin/zsh -lc 'printf hello'",
      aggregatedOutput,
    });
    expect(data.resultTruncated).toBeUndefined();
  });

  it("retains Claude rawOutput and folds ACP content into rawOutput", () => {
    const claudeStdout = `hello from claude\n${"y".repeat(5000)}`;
    const acpText = `hello from acp\n${"z".repeat(5000)}`;
    const claude = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          command: "printf hello",
          rawOutput: { stdout: claudeStdout },
        },
      }),
    );
    const acp = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          command: "printf hello",
          content: [
            { type: "content", content: { type: "text", text: acpText } },
            { type: "content", content: { type: "image", data: "…" } },
          ],
        },
      }),
    );

    const claudeData = (claude.payload as Record<string, unknown>).data as Record<string, unknown>;
    const acpData = (acp.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(claudeData.rawOutput).toEqual({ stdout: claudeStdout });
    expect(acpData.rawOutput).toEqual({ content: acpText });
    expect(acpData.content).toBeUndefined();
    expect(acpData.resultTruncated).toBeUndefined();
  });

  it("caps folded ACP content like other retained output", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          command: "cat big",
          content: [{ type: "content", content: { type: "text", text: "a".repeat(60_000) } }],
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    const rawOutput = data.rawOutput as Record<string, unknown>;
    expect(typeof rawOutput.content).toBe("string");
    expect((rawOutput.content as string).length).toBeLessThan(60_000);
    expect(data.resultTruncated).toBe(true);
  });

  it("normalizes Claude and OpenCode command inputs while retaining provider output", () => {
    const claude = projectActivityPayload(
      activity({
        itemType: "command_execution",
        toolCallId: "claude-call-1",
        data: {
          toolName: "Bash",
          input: { command: "vp test run" },
          result: {
            type: "tool_result",
            content: [
              { type: "text", text: "tests passed" },
              { type: "text", text: "x".repeat(5_000) },
            ],
          },
        },
      }),
    );
    const openCode = projectActivityPayload(
      activity({
        itemType: "command_execution",
        toolCallId: "opencode-call-1",
        data: {
          tool: "bash",
          state: {
            status: "running",
            input: { command: "vp lint" },
            output: "x".repeat(5_000),
          },
        },
      }),
    );

    // Output stays intact under the projection cap so expanded work-log rows
    // can show it; only the command is normalized to a top-level field.
    expect(claude.payload).toMatchObject({
      toolCallId: "claude-call-1",
      data: {
        command: "vp test run",
        result: {
          content: [
            { type: "text", text: "tests passed" },
            { type: "text", text: "x".repeat(5_000) },
          ],
        },
      },
    });
    expect(openCode.payload).toMatchObject({
      toolCallId: "opencode-call-1",
      data: { command: "vp lint", state: { status: "running", output: "x".repeat(5_000) } },
    });
    expect((claude.payload as Record<string, unknown>).data).not.toHaveProperty("resultTruncated");
  });

  it("keeps full Claude Read image paths through repeated projection", () => {
    const imagePath = `/workspace/${"nested folder/".repeat(16)}reference image.webp`;
    const projected = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        detail: 'Read: {"file_path":"truncated..."}',
        data: {
          toolName: "Read",
          input: { file_path: imagePath },
          result: { content: "Image Size: 1280x720." },
        },
      }),
    );
    const projectedAgain = projectActivityPayload(projected);

    expect(projected.payload).toMatchObject({ data: { imagePath } });
    expect(projectedAgain.payload).toMatchObject({ data: { imagePath } });

    const textRead = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        data: { toolName: "Read", input: { file_path: "/workspace/src/index.ts" } },
      }),
    );
    expect(textRead.payload).not.toMatchObject({ data: { imagePath: expect.anything() } });
  });

  it("slims Codex-shaped mcp_tool_call items to rendered fields while retaining the result", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          item: {
            type: "mcpToolCall",
            id: "item-1",
            tool: "fetch_pr",
            server: "github",
            status: "completed",
            arguments: { pr: 42 },
            durationMs: 1200,
            result: {
              content: [{ type: "text", text: `PR body line one\n${"x".repeat(5000)}` }],
              structuredContent: { huge: "y".repeat(5000) },
            },
            _meta: { internal: true },
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    const item = data.item as Record<string, unknown>;
    expect(item.tool).toBe("fetch_pr");
    expect(item.server).toBe("github");
    expect(item.arguments).toEqual({ pr: 42 });
    expect(item._meta).toBeUndefined();
    expect(item.result).toEqual({
      content: [{ type: "text", text: `PR body line one\n${"x".repeat(5000)}` }],
      structuredContent: { huge: "y".repeat(5000) },
    });
    expect(data.resultTruncated).toBeUndefined();
  });

  it("keeps Claude-shaped mcp_tool_call data (toolName/input/result block) intact", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          toolName: "mcp__github__fetch_pr",
          input: { pr: 42 },
          result: {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: `first line of output\n${"z".repeat(5000)}` }],
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.toolName).toBe("mcp__github__fetch_pr");
    expect(data.input).toEqual({ pr: 42 });
    expect(data.result).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: [{ type: "text", text: `first line of output\n${"z".repeat(5000)}` }],
    });
    expect(data.resultTruncated).toBeUndefined();
  });

  it.each([
    {
      item: {
        server: "t3-code",
        tool: "preview_open",
        result: { structuredContent: { url: "https://example.com/" } },
      },
    },
    {
      toolName: "mcp__t3-code__preview_navigate",
      result: { content: '{"url":"https://example.com/"}' },
    },
    { tool: "t3-code_preview_status", state: { output: '{"url":"https://example.com/"}' } },
    {
      toolName: "mcp__t3_code__preview_snapshot",
      result: {
        content: [
          { type: "text", text: '{"url":"https://example.com/"}' },
          { type: "text", text: "Snapshot text was bounded. Omitted: accessibilityTree." },
        ],
      },
    },
    {
      toolName: "mcp__t3-code__preview_click",
      result: { content: '{"toolIcon":{"_tag":"website","pageUrl":"https://example.com/"}}' },
    },
    {
      toolName: "mcp__t3_code__preview_snapshot",
      result: { content: '{"url":"https://example.com/"}\n{"accessibilityTree":"truncated' },
    },
    ...[false, true].map((truncated) => ({
      toolName: "mcp__t3_code__preview_snapshot",
      result: {
        content: JSON.stringify({
          content: [{ type: "text", text: '{"url":"https://example.com/"}' }],
          structuredContent: { url: "https://example.com/", visibleText: "page" },
        }).slice(0, truncated ? -5 : undefined),
      },
    })),
    ...[
      "type",
      "press",
      "scroll",
      "resize",
      "set_appearance",
      "evaluate",
      "wait_for",
      "recording_start",
      "recording_stop",
    ].map((action) => ({
      toolName: `mcp__t3_code__preview_${action}`,
      result: { content: '{"toolIcon":{"_tag":"website","pageUrl":"https://example.com/"}}' },
    })),
  ])("preserves the preview page favicon through result slimming", (data) => {
    const projected = projectActivityPayload(activity({ itemType: "mcp_tool_call", data }));
    const icon = { _tag: "website", pageUrl: "https://example.com/" };
    expect(projected.payload).toMatchObject({ toolIcon: icon });
    expect(projectActivityPayload(projected).payload).toMatchObject({ toolIcon: icon });
  });

  it.each([
    { toolName: "mcp__other__preview_open", result: { content: '{"url":"https://example.com/"}' } },
    {
      toolName: "mcp__t3-code__preview_evaluate",
      result: { content: '{"url":"https://example.com/"}' },
    },
    {
      toolName: "mcp__t3-code__preview_open",
      result: { isError: true, content: '{"url":"https://example.com/"}' },
    },
    { toolName: "mcp__t3-code__preview_open", result: { content: "malformed JSON" } },
    { toolName: "mcp__t3-code__preview_open", result: { content: '{"url":"about:blank"}' } },
  ])("keeps the fallback for unrelated tools, failed navigation, and missing page URLs", (data) => {
    expect(
      projectActivityPayload(activity({ itemType: "mcp_tool_call", data })).payload,
    ).not.toHaveProperty("toolIcon");
  });

  it("passes task lifecycle payloads (no data field) through untouched", () => {
    const source = activity({
      taskId: "task-9",
      title: "Audit auth",
      role: "explorer",
      model: "opus",
      effort: "high",
      workflowName: "audit-flow",
      phases: [{ index: 0, title: "Audit" }],
      typedUsage: { totalTokens: 1200 },
      runHandles: { runId: "run-1", scriptPath: "/tmp/wf.js" },
      timelineBypass: true,
    });
    const projected = projectActivityPayload(source);
    expect(projected.payload).toEqual(source.payload);
  });
});

describe("projectActivityPayload legacy retraction compatibility", () => {
  function retractionFailure(detail: string): OrchestrationThreadActivity {
    return {
      id: "retraction-failure-1",
      tone: "error",
      kind: "turn.retract.failed",
      summary: "Message retract failed",
      payload: {
        requestId: "request-1",
        stage: "provider-rollback",
        retryable: false,
        detail,
      },
      turnId: "turn-1",
      createdAt: "2026-08-12T18:49:47.397Z",
    } as unknown as OrchestrationThreadActivity;
  }

  it("marks replayed unavailable-boundary failures silent", () => {
    const projected = projectActivityPayload(
      retractionFailure(
        "Provider adapter validation failed (claudeAgent) in rollbackThreadTo: Provider history has 3 turns, below retained boundary 11.",
      ),
    );

    expect(projected.payload).toMatchObject({
      requestId: "request-1",
      detail:
        "Provider adapter validation failed (claudeAgent) in rollbackThreadTo: Provider history has 3 turns, below retained boundary 11.",
      silent: true,
    });
  });

  it("keeps unrelated retraction failures visible", () => {
    const source = retractionFailure(
      "Provider adapter validation failed (claudeAgent) in rollbackThreadTo: retainedTurnCount must be an integer >= 0.",
    );

    expect(projectActivityPayload(source)).toBe(source);
  });
});
