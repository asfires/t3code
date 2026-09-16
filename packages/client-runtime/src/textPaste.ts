export const PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES = 32 * 1024;
/** A paste this long, or with this many lines, folds into an editable chip. */
export const PASTED_TEXT_RECORD_MIN_CHARS = 1_000;
export const PASTED_TEXT_RECORD_MIN_LINES = 20;

const textEncoder = new TextEncoder();

export type PastedTextDisposition = "attachment" | "record" | "inline";

export function isPasteAsTextShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  macPlatform: boolean,
): boolean {
  return (
    event.key.toLowerCase() === "v" &&
    event.shiftKey &&
    !event.altKey &&
    (macPlatform ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
  );
}

/** Whether a paste is long enough to fold into a chip rather than sit in the prompt. */
export function exceedsPastedTextRecordThreshold(text: string): boolean {
  if (text.length >= PASTED_TEXT_RECORD_MIN_CHARS) return true;
  let newlines = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    newlines += 1;
    if (newlines + 1 >= PASTED_TEXT_RECORD_MIN_LINES) return true;
  }
  return false;
}

/**
 * Large clipboard text becomes a file so an agent can inspect it selectively.
 * The threshold is byte-based: character counts substantially understate the
 * context cost of some Unicode-heavy clipboard contents.
 *
 * Between the record threshold and the file threshold, a caller that supports
 * context records gets `record`: the text still reaches the model inline, but
 * the composer shows one editable chip instead of a wall of text.
 */
export function pastedTextDisposition(input: {
  readonly text: string;
  readonly canAttach: boolean;
  readonly bypassAutoAttachment?: boolean;
  readonly wouldExceedInputLimit?: boolean;
  readonly supportsRecords?: boolean;
}): PastedTextDisposition {
  if (input.bypassAutoAttachment || input.text.length === 0) {
    return "inline";
  }
  const attachment =
    input.canAttach &&
    (input.wouldExceedInputLimit ||
      input.text.length >= PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES ||
      textEncoder.encode(input.text).byteLength >= PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES);
  if (attachment) return "attachment";
  if (input.supportsRecords && exceedsPastedTextRecordThreshold(input.text)) return "record";
  return "inline";
}

/** Stable, human-readable names when a draft contains several folded pastes. */
export function nextPastedTextFileName(existingNames: ReadonlyArray<string>): string {
  const names = new Set(existingNames.map((name) => name.toLowerCase()));
  if (!names.has("pasted-text.txt")) {
    return "pasted-text.txt";
  }
  for (let sequence = 2; ; sequence += 1) {
    const candidate = `pasted-text-${sequence}.txt`;
    if (!names.has(candidate)) {
      return candidate;
    }
  }
}

export function replaceTextSelection(input: {
  readonly value: string;
  readonly selection: { readonly start: number; readonly end: number };
  readonly text: string;
}): { readonly value: string; readonly cursor: number } {
  const start = Math.max(0, Math.min(input.value.length, input.selection.start));
  const end = Math.max(start, Math.min(input.value.length, input.selection.end));
  return {
    value: `${input.value.slice(0, start)}${input.text}${input.value.slice(end)}`,
    cursor: start + input.text.length,
  };
}

export function wouldTextPasteExceedLimit(input: {
  readonly valueLength: number;
  readonly selection: { readonly start: number; readonly end: number };
  readonly textLength: number;
  readonly maxLength: number;
}): boolean {
  const start = Math.max(0, Math.min(input.valueLength, input.selection.start));
  const end = Math.max(start, Math.min(input.valueLength, input.selection.end));
  return input.valueLength - (end - start) + input.textLength > input.maxLength;
}
