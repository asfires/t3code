import { ComposerContextId, MessageId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry, WorkLogEntry } from "../../session-logic";
import type { ChatMessage } from "../../types";
import {
  deriveLastUserMessageRestoredContent,
  deriveLastUserMessageRestoredText,
  findLastUserMessagePopCandidate,
  IMAGE_ONLY_MESSAGE_PLACEHOLDER,
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  isLastUserMessagePopWindowOpen,
  mergePoppedPrompt,
} from "./lastUserMessagePop";

function message(input: {
  id: string;
  role: ChatMessage["role"];
  text?: string;
  turnId?: TurnId | null;
  createdAt?: string;
}): ChatMessage {
  const createdAt = input.createdAt ?? "2026-08-10T12:00:00.000Z";
  return {
    id: MessageId.make(input.id),
    role: input.role,
    text: input.text ?? input.id,
    turnId: input.turnId ?? null,
    streaming: false,
    createdAt,
    updatedAt: createdAt,
  };
}

function messageEntry(value: ChatMessage): TimelineEntry {
  return { id: value.id, kind: "message", createdAt: value.createdAt, message: value };
}

function workEntry(input: {
  id: string;
  turnId: TurnId;
  tone: WorkLogEntry["tone"];
  label: string;
}): TimelineEntry {
  const entry: WorkLogEntry = {
    id: input.id,
    createdAt: "2026-08-10T12:00:01.000Z",
    turnId: input.turnId,
    tone: input.tone,
    label: input.label,
  };
  return { id: input.id, kind: "work", createdAt: entry.createdAt, entry };
}

describe("last user message pop window", () => {
  const codexTurnId = TurnId.make("codex-turn");
  const claudeTurnId = TurnId.make("claude-turn");

  it("opens for a running Codex turn with no output and ignores reasoning-only state", () => {
    const user = message({ id: "user-codex", role: "user" });
    expect(
      isLastUserMessagePopWindowOpen({
        phase: "running",
        activeTurnId: codexTurnId,
        timelineEntries: [messageEntry(user)],
      }),
    ).toBe(true);
    expect(
      isLastUserMessagePopWindowOpen({
        phase: "running",
        activeTurnId: codexTurnId,
        timelineEntries: [
          messageEntry(user),
          workEntry({
            id: "codex-reasoning",
            turnId: codexTurnId,
            tone: "thinking",
            label: "Reasoning",
          }),
        ],
      }),
    ).toBe(true);
  });

  it("closes when Codex tool output or assistant text reaches the timeline", () => {
    const user = message({ id: "user-codex", role: "user" });
    expect(
      isLastUserMessagePopWindowOpen({
        phase: "running",
        activeTurnId: codexTurnId,
        timelineEntries: [
          messageEntry(user),
          workEntry({
            id: "codex-command",
            turnId: codexTurnId,
            tone: "tool",
            label: "Ran command",
          }),
        ],
      }),
    ).toBe(false);
    expect(
      isLastUserMessagePopWindowOpen({
        phase: "running",
        activeTurnId: codexTurnId,
        timelineEntries: [
          messageEntry(user),
          messageEntry(
            message({
              id: "assistant-codex",
              role: "assistant",
              text: "Starting now",
              turnId: codexTurnId,
            }),
          ),
        ],
      }),
    ).toBe(false);
  });

  it("keeps Claude thinking eligible but closes on a Claude tool activity", () => {
    const user = message({ id: "user-claude", role: "user" });
    expect(
      isLastUserMessagePopWindowOpen({
        phase: "running",
        activeTurnId: claudeTurnId,
        timelineEntries: [
          messageEntry(user),
          workEntry({
            id: "claude-thinking",
            turnId: claudeTurnId,
            tone: "thinking",
            label: "Thinking",
          }),
        ],
      }),
    ).toBe(true);
    expect(
      isLastUserMessagePopWindowOpen({
        phase: "running",
        activeTurnId: claudeTurnId,
        timelineEntries: [
          messageEntry(user),
          workEntry({
            id: "claude-tool",
            turnId: claudeTurnId,
            tone: "tool",
            label: "Read file",
          }),
        ],
      }),
    ).toBe(false);
  });

  it("is closed for an idle thread", () => {
    expect(
      isLastUserMessagePopWindowOpen({
        phase: "ready",
        activeTurnId: codexTurnId,
        timelineEntries: [],
      }),
    ).toBe(false);
  });

  it("opens while a dispatched turn is still starting", () => {
    expect(
      isLastUserMessagePopWindowOpen({
        phase: "connecting",
        activeTurnId: null,
        timelineEntries: [],
      }),
    ).toBe(true);
    expect(
      isLastUserMessagePopWindowOpen({
        phase: "ready",
        activeTurnId: null,
        timelineEntries: [],
        localTurnStartPending: true,
      }),
    ).toBe(true);
  });

  it("closes while a correlated retraction is pending", () => {
    expect(
      isLastUserMessagePopWindowOpen({
        phase: "running",
        activeTurnId: codexTurnId,
        timelineEntries: [],
        retractionPending: true,
      }),
    ).toBe(false);
  });
});

describe("last user message selection", () => {
  it("selects an optimistic first message for turn zero", () => {
    const optimistic = message({ id: "optimistic-first", role: "user" });
    expect(
      findLastUserMessagePopCandidate({
        messages: [optimistic],
      }),
    ).toEqual({ message: optimistic });
  });

  it("selects the optimistic follow-up after server messages", () => {
    const first = message({
      id: "user-1",
      role: "user",
      createdAt: "2026-08-10T12:00:00.000Z",
    });
    const assistant = message({
      id: "assistant-1",
      role: "assistant",
      turnId: TurnId.make("turn-1"),
      createdAt: "2026-08-10T12:00:01.000Z",
    });
    const optimistic = message({
      id: "optimistic-2",
      role: "user",
      createdAt: "2026-08-10T12:00:03.000Z",
    });
    expect(
      findLastUserMessagePopCandidate({
        messages: [first, assistant, optimistic],
      }),
    ).toEqual({ message: optimistic });
  });

  it("selects the newest user message without checkpoint-race heuristics", () => {
    const completed = message({ id: "completed-user", role: "user" });
    expect(
      findLastUserMessagePopCandidate({
        messages: [completed],
      }),
    ).toEqual({ message: completed });
  });
});

it("keeps messages with file attachments in history until files can be restored", () => {
  expect(
    findLastUserMessagePopCandidate({
      messages: [
        {
          ...message({ id: "with-file", role: "user" }),
          attachments: [
            { type: "file", id: "file", name: "notes.txt", mimeType: "text/plain", sizeBytes: 8 },
          ],
        },
      ],
    }),
  ).toBeNull();
});

describe("last user message restored text", () => {
  it("removes the injected effort prefix and terminal and element decorations", () => {
    const decorated = [
      "Ultrathink:",
      "Fix the save flow",
      "",
      "<terminal_context>",
      "- Terminal 1 line 12:",
      "  12 | pnpm test",
      "</terminal_context>",
      "",
      "<element_context>",
      "- <SaveButton>:",
      "  selector: button.save",
      "</element_context>",
    ].join("\n");

    expect(deriveLastUserMessageRestoredText(decorated)).toBe("Fix the save flow");
  });

  it("turns the image-only placeholder back into an empty prompt", () => {
    expect(deriveLastUserMessageRestoredText(IMAGE_ONLY_MESSAGE_PLACEHOLDER)).toBe("");
    expect(deriveLastUserMessageRestoredText(ATTACHMENT_ONLY_BOOTSTRAP_PROMPT)).toBe("");
  });

  it("keeps pasted-text chips and rebuilds their drafts, dropping other context", () => {
    const restored = deriveLastUserMessageRestoredContent({
      text: "Fix [Pasted text](t3-context://v1/pasted-text/p1) with [T1](t3-context://v1/terminal/t1)",
      context: {
        version: 1,
        records: [
          {
            version: 1,
            contextId: ComposerContextId.make("p1"),
            kind: "pasted-text",
            label: "Pasted text",
            text: "line one\nline two",
          },
          {
            version: 1,
            contextId: ComposerContextId.make("t1"),
            kind: "terminal",
            label: "T1",
            terminalId: "term-1",
            terminalLabel: "Terminal 1",
            lineStart: 1,
            lineEnd: 1,
            text: "ls",
          },
        ],
      },
    });
    expect(restored.pastedTexts).toEqual([
      { id: "p1", createdAt: expect.any(String), text: "line one\nline two" },
    ]);
    expect(restored.prompt).toBe(
      "Fix [Pasted text](t3-context://v1/pasted-text/pasted-text_p1) with",
    );
  });

  it("drops a pasted-text chip whose record is missing", () => {
    expect(
      deriveLastUserMessageRestoredContent({
        text: "Fix [Pasted text](t3-context://v1/pasted-text/p1) now",
      }),
    ).toEqual({ prompt: "Fix now", pastedTexts: [] });
  });

  it("merges with an in-progress draft using stash restore semantics", () => {
    expect(mergePoppedPrompt("new follow-up  \n", "original message")).toBe(
      "new follow-up\n\noriginal message",
    );
    expect(mergePoppedPrompt("", "original message")).toBe("original message");
    expect(mergePoppedPrompt("new follow-up", "")).toBe("new follow-up");
  });
});
