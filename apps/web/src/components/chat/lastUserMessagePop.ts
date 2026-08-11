import type { TurnId } from "@t3tools/contracts";

import { extractTrailingElementContexts } from "../../lib/elementContext";
import { extractTrailingPreviewAnnotation } from "../../lib/previewAnnotation";
import { deriveDisplayedUserMessageState } from "../../lib/terminalContext";
import { parseReviewCommentMessageSegments } from "../../reviewCommentContext";
import type { TimelineEntry } from "../../session-logic";
import type { ChatMessage, SessionPhase } from "../../types";
import type { ComposerImageAttachment } from "../../composerDraftStore";

export const LAST_USER_MESSAGE_POP_SETTLE_TIMEOUT_MS = 15_000;
export const IMAGE_ONLY_MESSAGE_PLACEHOLDER =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";

export interface LastUserMessagePopCandidate {
  message: ChatMessage;
  turnCount: number;
}

export function findLastUserMessagePopCandidate(input: {
  messages: ReadonlyArray<ChatMessage>;
  turnCount: number;
  latestCheckpointCompletedAt: string | null;
}): LastUserMessagePopCandidate | null {
  const message = input.messages.findLast((entry) => entry.role === "user");
  if (!message) return null;
  if (
    input.latestCheckpointCompletedAt !== null &&
    message.createdAt < input.latestCheckpointCompletedAt
  ) {
    return null;
  }
  return { message, turnCount: input.turnCount };
}

export function isLastUserMessagePopWindowOpen(input: {
  phase: SessionPhase;
  activeTurnId: TurnId | null;
  timelineEntries: ReadonlyArray<TimelineEntry>;
}): boolean {
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
      case "turn-plan":
        return entry.turnPlan.turnId === input.activeTurnId;
    }
  });
}

export function mergePoppedPrompt(currentPrompt: string, poppedPrompt: string): string {
  if (poppedPrompt.length === 0) return currentPrompt;
  return currentPrompt.trim().length
    ? `${currentPrompt.replace(/\s+$/, "")}\n\n${poppedPrompt}`
    : poppedPrompt;
}

function stripDisplayedReviewComments(prompt: string): string {
  const segments = parseReviewCommentMessageSegments(prompt);
  if (!segments.some((segment) => segment.kind === "review-comment")) {
    return prompt;
  }
  return segments
    .flatMap((segment) => (segment.kind === "text" ? [segment.text] : []))
    .join("")
    .trimEnd();
}

export function deriveLastUserMessageRestoredText(messageText: string): string {
  let visibleText = stripDisplayedReviewComments(messageText);
  while (true) {
    const extracted = extractTrailingPreviewAnnotation(visibleText);
    if (!extracted.annotation) break;
    visibleText = extracted.promptText;
  }

  visibleText = deriveDisplayedUserMessageState(visibleText).visibleText;
  visibleText = extractTrailingElementContexts(visibleText).promptText;
  if (visibleText === IMAGE_ONLY_MESSAGE_PLACEHOLDER) return "";
  return visibleText.startsWith("Ultrathink:\n")
    ? visibleText.slice("Ultrathink:\n".length)
    : visibleText;
}

export async function captureLastUserMessageImages(
  message: ChatMessage,
): Promise<{ images: ComposerImageAttachment[]; failedNames: string[] }> {
  const results = await Promise.all(
    (message.attachments ?? []).map(async (attachment) => {
      if (!attachment.previewUrl) return { name: attachment.name, image: null };
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
