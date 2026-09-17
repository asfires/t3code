import type { TurnId } from "@t3tools/contracts";

import {
  ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
  recallableComposerPrompt,
} from "./composerPromptHistory";

export { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT };
import type { TimelineEntry } from "../../session-logic";
import { isFileAttachment, type ChatMessage, type SessionPhase } from "../../types";
import type { ComposerImageAttachment } from "../../composerDraftStore";
import { IMAGE_ONLY_MESSAGE_PLACEHOLDER } from "./composerPromptRecovery";
export {
  IMAGE_ONLY_MESSAGE_PLACEHOLDER,
  restoreComposerPrompt as deriveLastUserMessageRestoredContent,
  type RestoredComposerPrompt as LastUserMessageRestoredContent,
} from "./composerPromptRecovery";

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
  return (message.attachments ?? []).every(
    (attachment) => attachment.type === "image" || isFileAttachment(attachment),
  )
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
