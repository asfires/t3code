import type { OrchestrationMessageContext, TurnId } from "@t3tools/contracts";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";

import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  recallableComposerPrompt,
} from "./composerPromptHistory";

export { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT };
import type { TimelineEntry } from "../../session-logic";
import type { ChatMessage, SessionPhase } from "../../types";
import type { ComposerImageAttachment } from "../../composerDraftStore";
import {
  pastedTextContextReference,
  pastedTextDraftFromRecord,
  resolveUserMessageContext,
} from "../../lib/composerContextRecords";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import type { PastedTextDraft } from "../../lib/pastedTextContext";

export const IMAGE_ONLY_MESSAGE_PLACEHOLDER =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";

export interface LastUserMessagePopCandidate {
  message: ChatMessage;
}

export function findLastUserMessagePopCandidate(input: {
  messages: ReadonlyArray<ChatMessage>;
}): LastUserMessagePopCandidate | null {
  const index = input.messages.findLastIndex((entry) => entry.role === "user");
  const message = index === -1 ? undefined : input.messages[index];
  if (!message) return null;
  // A message the assistant already answered is not what a running turn is
  // working on, even when that turn has produced nothing yet (a turn started
  // for a message that was retracted in the meantime, for example).
  const answered = input.messages
    .slice(index + 1)
    .some((entry) => entry.role === "assistant" && entry.text.length > 0);
  if (answered) return null;
  return (message.attachments ?? []).every((attachment) => attachment.type === "image")
    ? { message }
    : null;
}

export function isLastUserMessagePopWindowOpen(input: {
  phase: SessionPhase;
  activeTurnId: TurnId | null;
  timelineEntries: ReadonlyArray<TimelineEntry>;
  localTurnStartPending?: boolean;
  retractionPending?: boolean;
}): boolean {
  if (input.retractionPending) return false;
  if (input.localTurnStartPending || input.phase === "connecting") {
    return true;
  }
  if (input.phase !== "running" || input.activeTurnId === null) {
    return false;
  }

  return !input.timelineEntries.some((entry) => {
    switch (entry.kind) {
      case "message":
        return (
          entry.message.role === "assistant" &&
          entry.message.turnId === input.activeTurnId &&
          entry.message.text.length > 0
        );
      case "work":
        return entry.entry.turnId === input.activeTurnId && entry.entry.tone !== "thinking";
      case "proposed-plan":
        return entry.proposedPlan.turnId === input.activeTurnId;
    }
  });
}

export function mergePoppedPrompt(currentPrompt: string, poppedPrompt: string): string {
  if (poppedPrompt.length === 0) return currentPrompt;
  return currentPrompt.trim().length
    ? `${currentPrompt.replace(/\s+$/, "")}\n\n${poppedPrompt}`
    : poppedPrompt;
}

export function deriveLastUserMessageRestoredText(messageText: string): string {
  const visibleText = recallableComposerPrompt(messageText);
  if (
    visibleText === IMAGE_ONLY_MESSAGE_PLACEHOLDER ||
    visibleText === ATTACHMENT_ONLY_BOOTSTRAP_PROMPT
  )
    return "";
  return visibleText;
}

export interface LastUserMessageRestoredContent {
  prompt: string;
  pastedTexts: PastedTextDraft[];
}

const RESTORED_REFERENCE_KINDS: ReadonlySet<string> = new Set(["pasted-text"]);

/**
 * A popped message comes back as the user wrote it. Pasted text is the user's own content,
 * so its chips stay in the prompt and their records become drafts again; other context kinds
 * are stripped like any recall, since their payloads belong to the turn they were captured in.
 */
export function deriveLastUserMessageRestoredContent(message: {
  text: string;
  context?: OrchestrationMessageContext | undefined;
}): LastUserMessageRestoredContent {
  const resolved = resolveUserMessageContext(message);
  const draftsByContextId = new Map<string, PastedTextDraft>();
  for (const record of resolved.records) {
    if (record.kind !== "pasted-text" || "payload" in record) continue;
    draftsByContextId.set(record.contextId, pastedTextDraftFromRecord(record));
  }
  let prompt = recallableComposerPrompt(resolved.text, {
    keepReferenceKinds: RESTORED_REFERENCE_KINDS,
  });
  if (prompt === IMAGE_ONLY_MESSAGE_PLACEHOLDER || prompt === ATTACHMENT_ONLY_BOOTSTRAP_PROMPT) {
    return { prompt: "", pastedTexts: [] };
  }
  // Another client may have minted ids in its own grammar; the chip must point at the id the
  // rebuilt draft will carry.
  const restored = new Map<string, PastedTextDraft>();
  for (const occurrence of collectComposerContextReferences(prompt).toReversed()) {
    const draft = draftsByContextId.get(occurrence.contextId);
    let { start, end } = occurrence;
    if (draft) {
      restored.set(draft.id, draft);
      prompt =
        prompt.slice(0, start) +
        formatInlineContextReference(pastedTextContextReference(draft)) +
        prompt.slice(end);
      continue;
    }
    // A chip without its record cannot be rebuilt; drop it with its separating space.
    if (prompt[end] === " ") end += 1;
    else if (prompt[start - 1] === " ") start -= 1;
    prompt = prompt.slice(0, start) + prompt.slice(end);
  }
  return { prompt, pastedTexts: [...restored.values()].toReversed() };
}

export async function captureLastUserMessageImages(
  message: ChatMessage,
): Promise<{ images: ComposerImageAttachment[]; failedNames: string[] }> {
  const results = await Promise.all(
    (message.attachments ?? []).map(async (attachment) => {
      if (attachment.type !== "image" || !("previewUrl" in attachment) || !attachment.previewUrl)
        return { name: attachment.name, image: null };
      try {
        const response = await fetch(attachment.previewUrl);
        if (!response.ok) return { name: attachment.name, image: null };
        const blob = await response.blob();
        const file = new File([blob], attachment.name, { type: attachment.mimeType });
        const previewUrl =
          typeof URL === "undefined" || typeof URL.createObjectURL !== "function"
            ? attachment.previewUrl
            : URL.createObjectURL(file);
        return {
          name: attachment.name,
          image: {
            ...attachment,
            type: "image",
            sizeBytes: file.size,
            previewUrl,
            file,
          } satisfies ComposerImageAttachment,
        };
      } catch {
        return { name: attachment.name, image: null };
      }
    }),
  );
  return {
    images: results.flatMap((result) => (result.image ? [result.image] : [])),
    failedNames: results.flatMap((result) => (result.image ? [] : [result.name])),
  };
}
