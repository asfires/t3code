const PASTED_TEXT_START = "\uE000t3-pasted-text:";
const PASTED_TEXT_END = "\uE001";

export const PASTED_TEXT_MIN_CHARACTERS = 1_000;
export const PASTED_TEXT_MIN_LINES = 20;

export type PastedTextSegment =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "pasted-text";
      readonly text: string;
      readonly source: string;
    };

export function shouldPresentPasteAsBlock(text: string): boolean {
  return (
    text.length >= PASTED_TEXT_MIN_CHARACTERS ||
    text.split("\n", PASTED_TEXT_MIN_LINES).length >= PASTED_TEXT_MIN_LINES
  );
}

export function serializePastedText(text: string): string {
  return `${PASTED_TEXT_START}${text.length}:${text}${PASTED_TEXT_END}`;
}

function pushTextSegment(segments: PastedTextSegment[], text: string): void {
  if (text.length === 0) return;
  const previous = segments[segments.length - 1];
  if (previous?.type === "text") {
    segments[segments.length - 1] = { type: "text", text: previous.text + text };
    return;
  }
  segments.push({ type: "text", text });
}

export function splitPastedTextSegments(value: string): PastedTextSegment[] {
  const segments: PastedTextSegment[] = [];
  let cursor = 0;

  while (cursor < value.length) {
    const markerStart = value.indexOf(PASTED_TEXT_START, cursor);
    if (markerStart < 0) {
      pushTextSegment(segments, value.slice(cursor));
      break;
    }

    const lengthStart = markerStart + PASTED_TEXT_START.length;
    const lengthEnd = value.indexOf(":", lengthStart);
    const rawLength = lengthEnd < 0 ? "" : value.slice(lengthStart, lengthEnd);
    if (!/^\d+$/.test(rawLength)) {
      pushTextSegment(segments, value.slice(cursor, lengthStart));
      cursor = lengthStart;
      continue;
    }

    const textLength = Number(rawLength);
    const textStart = lengthEnd + 1;
    const textEnd = textStart + textLength;
    const markerEnd = textEnd + PASTED_TEXT_END.length;
    if (
      !Number.isSafeInteger(textLength) ||
      textEnd > value.length ||
      value.slice(textEnd, markerEnd) !== PASTED_TEXT_END
    ) {
      pushTextSegment(segments, value.slice(cursor, lengthStart));
      cursor = lengthStart;
      continue;
    }

    pushTextSegment(segments, value.slice(cursor, markerStart));
    segments.push({
      type: "pasted-text",
      text: value.slice(textStart, textEnd),
      source: value.slice(markerStart, markerEnd),
    });
    cursor = markerEnd;
  }

  return segments;
}

export function materializePastedText(value: string): string {
  return splitPastedTextSegments(value)
    .map((segment) => segment.text)
    .join("");
}

export function summarizePastedText(value: string): string {
  let pastedTextIndex = 0;
  return splitPastedTextSegments(value)
    .map((segment) => {
      if (segment.type === "text") return segment.text;
      pastedTextIndex += 1;
      return `Pasted text #${pastedTextIndex}`;
    })
    .join("");
}
