import type { OrchestrationMessageContext } from "@t3tools/contracts";
import type { PastedTextDraft } from "../../lib/pastedTextContext";
import { restoreComposerPrompt } from "./composerPromptRecovery";
export {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  recallableComposerPrompt,
} from "./composerPromptRecovery";

/**
 * Terminal-style prompt recall for the composer. ArrowUp on an empty
 * composer walks back through the active thread's sent prompts, ArrowDown
 * walks forward and restores the unsent draft past the newest entry.
 *
 * History is per thread and includes pasted-text records. It is derived from the thread's user
 * messages on every keypress, so there is no store to persist or sync.
 */

export interface ComposerPromptHistoryMessage {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly context?: OrchestrationMessageContext | undefined;
}

export interface ComposerPromptHistoryEntry {
  readonly id: string;
  readonly prompt: string;
  readonly pastedTexts: PastedTextDraft[];
}

/**
 * Active recall. `entryId` is resolved against the current entries on every
 * step, so a server ack replacing an optimistic message or an older page
 * loading cannot move the position. `recalled` is the text put in the
 * composer; once the composer no longer matches it, the user has edited or
 * sent and browsing is over.
 */
export interface ComposerPromptHistoryPosition {
  readonly entryId: string;
  readonly recalled: string;
}

/**
 * Prefer the id. A consecutive duplicate collapse can retire the recalled
 * id while the same text lives on under a newer one, so fall back to the
 * newest entry with matching text.
 */
function findActive(
  entries: ReadonlyArray<ComposerPromptHistoryEntry>,
  position: ComposerPromptHistoryPosition,
): number {
  const byId = entries.findIndex((entry) => entry.id === position.entryId);
  if (byId >= 0) return byId;
  return entries.findLastIndex((entry) => entry.prompt === position.recalled);
}

export interface ComposerPromptHistoryStep {
  readonly position: ComposerPromptHistoryPosition | null;
  readonly prompt: string;
  readonly pastedTexts: PastedTextDraft[];
}

function samePastedTexts(
  left: ReadonlyArray<PastedTextDraft>,
  right: ReadonlyArray<PastedTextDraft>,
): boolean {
  return (
    left.length === right.length &&
    left.every((paste, index) => paste.id === right[index]?.id && paste.text === right[index]?.text)
  );
}

/**
 * Oldest first. Consecutive identical prompts collapse into the newest one,
 * matching shell `HISTCONTROL=ignoredups`. Image-only sends have no text and
 * are skipped.
 */
export function buildComposerPromptHistoryEntries(
  messages: ReadonlyArray<ComposerPromptHistoryMessage>,
): ComposerPromptHistoryEntry[] {
  const entries: ComposerPromptHistoryEntry[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    const { prompt, pastedTexts } = restoreComposerPrompt(message);
    if (prompt.length === 0) continue;
    const previous = entries[entries.length - 1];
    if (
      previous &&
      previous.prompt === prompt &&
      samePastedTexts(previous.pastedTexts, pastedTexts)
    ) {
      entries[entries.length - 1] = { id: message.id, prompt, pastedTexts };
      continue;
    }
    entries.push({ id: message.id, prompt, pastedTexts });
  }
  return entries;
}

/**
 * Returns null when the key should fall through to normal caret movement.
 * Backward starts only from an empty composer and stops at the oldest entry.
 * Forward past the newest entry empties the composer and ends browsing. An
 * edited or sent recall no longer matches `recalled`, so browsing restarts
 * from scratch on the next backward step.
 */
export function stepComposerPromptHistory(input: {
  readonly direction: "backward" | "forward";
  readonly entries: ReadonlyArray<ComposerPromptHistoryEntry>;
  readonly position: ComposerPromptHistoryPosition | null;
  readonly currentPrompt: string;
  readonly currentPastedTexts?: ReadonlyArray<PastedTextDraft>;
}): ComposerPromptHistoryStep | null {
  const { entries, position, currentPrompt } = input;
  const candidateIndex =
    position && position.recalled === currentPrompt ? findActive(entries, position) : -1;
  const activeIndex =
    candidateIndex >= 0 &&
    samePastedTexts(entries[candidateIndex]!.pastedTexts, input.currentPastedTexts ?? [])
      ? candidateIndex
      : -1;

  if (input.direction === "backward") {
    if (activeIndex < 0 && currentPrompt.length > 0) return null;
    const entry = entries[activeIndex < 0 ? entries.length - 1 : activeIndex - 1];
    if (!entry) return null;
    return {
      position: { entryId: entry.id, recalled: entry.prompt },
      prompt: entry.prompt,
      pastedTexts: entry.pastedTexts,
    };
  }

  if (activeIndex < 0) return null;
  const entry = entries[activeIndex + 1];
  if (!entry) return { position: null, prompt: "", pastedTexts: [] };
  return {
    position: { entryId: entry.id, recalled: entry.prompt },
    prompt: entry.prompt,
    pastedTexts: entry.pastedTexts,
  };
}
