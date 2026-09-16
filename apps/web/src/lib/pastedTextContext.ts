import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";

/**
 * A long paste folded into one chip. The text is the payload; the chip is the handle the
 * user edits or removes. Unlike a file attachment nothing is uploaded, and the provider
 * receives the text inline.
 */
export interface PastedTextDraft {
  id: string;
  createdAt: string;
  text: string;
}

export const PASTED_TEXT_CONTEXT_LABEL = "Pasted text";

const PASTED_TEXT_SUMMARY_MAX_CHARS = 80;

export function normalizePastedText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function hasPastedText(draft: { text: string }): boolean {
  return draft.text.trim().length > 0;
}

/**
 * "Pasted text #n" follows the order the chips sit in the prompt rather than the order they
 * were pasted, so removing one renumbers the rest and the numbers always read top to bottom.
 */
export function pastedTextOrdinals(prompt: string): ReadonlyMap<string, number> {
  const ordinals = new Map<string, number>();
  for (const occurrence of collectComposerContextReferences(prompt)) {
    if (occurrence.kind !== "pasted-text" || ordinals.has(occurrence.contextId)) continue;
    ordinals.set(occurrence.contextId, ordinals.size + 1);
  }
  return ordinals;
}

/** Stable string form of the ordinals, so React can memoize the map on its content. */
export function serializePastedTextOrdinals(ordinals: ReadonlyMap<string, number>): string {
  return [...ordinals].map(([contextId, ordinal]) => `${contextId}:${ordinal}`).join(",");
}

export function parsePastedTextOrdinals(key: string): ReadonlyMap<string, number> {
  const ordinals = new Map<string, number>();
  if (key.length === 0) return ordinals;
  for (const entry of key.split(",")) {
    const separator = entry.lastIndexOf(":");
    if (separator === -1) continue;
    ordinals.set(entry.slice(0, separator), Number(entry.slice(separator + 1)));
  }
  return ordinals;
}

export function formatPastedTextLabel(ordinal: number | undefined): string {
  return ordinal === undefined
    ? PASTED_TEXT_CONTEXT_LABEL
    : `${PASTED_TEXT_CONTEXT_LABEL} #${ordinal}`;
}

/** First line of the paste, for tooltips and accessible names. */
export function pastedTextSummary(text: string): string {
  const firstLine =
    text
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "";
  return firstLine.length > PASTED_TEXT_SUMMARY_MAX_CHARS
    ? `${firstLine.slice(0, PASTED_TEXT_SUMMARY_MAX_CHARS - 1)}…`
    : firstLine;
}

export function formatPastedTextStats(text: string): string {
  const lines = text.length === 0 ? 0 : text.split("\n").length;
  const characters = text.length;
  return `${lines.toLocaleString()} ${lines === 1 ? "line" : "lines"} · ${characters.toLocaleString()} ${characters === 1 ? "character" : "characters"}`;
}
