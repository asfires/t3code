import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import { ClipboardPasteIcon } from "lucide-react";
import { useState } from "react";

import { formatPastedTextStats, pastedTextSummary } from "~/lib/pastedTextContext";
import type { ContextPresentationCapability } from "../contextPresentationRegistry";
import { ContextChip, ContextChipLabel } from "../ContextChip";
import { ContextChipShell } from "../contextChipParts";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Popover, PopoverTrigger, PopoverPopup, PopoverTitle } from "../ui/popover";
import { Textarea } from "../ui/textarea";

interface PastedTextInlineChipProps {
  label: string;
  text: string;
  detailsMode: ContextPresentationCapability["details"];
  /** Present only while the paste is still a draft; a sent chip is read-only. Empty text removes it. */
  onEdit?: ((text: string) => void) | undefined;
  copyMarkdown?: string;
}

const PASTED_TEXT_BODY_CLASS_NAME =
  "max-h-80 overflow-auto whitespace-pre-wrap wrap-break-word bg-muted p-3 font-mono text-foreground text-xs leading-relaxed outline-none [tab-size:4] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

function PastedTextChipContent(props: { label: string }) {
  return (
    <>
      <ClipboardPasteIcon />
      <ContextChipLabel>{props.label}</ContextChipLabel>
    </>
  );
}

/**
 * Editing happens in a dialog rather than the chip itself: a paste that earned a chip is
 * long, and an inline chip is a poor host for a multi-line editor. Closing the dialog
 * commits: the draft record is rewritten and the chip keeps its id and place in the prompt,
 * or the chip is removed when nothing is left, the same as deleting it in the prompt.
 */
function PastedTextEditDialog(props: {
  label: string;
  text: string;
  onClose: (text: string) => void;
}) {
  // Mounted only while open, so the draft starts from the current text every time.
  const [draft, setDraft] = useState(props.text);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose(draft);
      }}
    >
      <DialogPopup size="wide">
        <DialogHeader>
          <DialogTitle>{props.label}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-2">
            <Textarea
              aria-label={`${props.label} contents`}
              variant="code"
              value={draft}
              spellCheck={false}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  props.onClose(draft);
                }
              }}
              style={{ minHeight: "40vh", maxHeight: "60vh", resize: "vertical" }}
            />
            <div className="flex items-center justify-between gap-3 text-secondary-label text-2xs">
              <span>{formatPastedTextStats(draft)}</span>
              <span>
                {draft.trim().length === 0
                  ? "Closing removes this pasted text."
                  : draft.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS
                    ? `Over the ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS.toLocaleString("en-US")}-character message limit.`
                    : "Changes apply when you close."}
              </span>
            </div>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

export function PastedTextInlineChip(props: PastedTextInlineChipProps) {
  const { label, text, detailsMode, onEdit } = props;
  const [editing, setEditing] = useState(false);
  const summary = pastedTextSummary(text);
  const accessibleLabel = `${label}${summary ? `, ${summary}` : ""}`;

  if (onEdit) {
    return (
      <>
        <ContextChip
          kind="pasted-text"
          render={<button type="button" />}
          aria-label={`${accessibleLabel}. Edit`}
          title={`${summary}\n${formatPastedTextStats(text)}`}
          data-markdown-copy={props.copyMarkdown}
          onClick={() => setEditing(true)}
        >
          <PastedTextChipContent label={label} />
        </ContextChip>
        {editing ? (
          <PastedTextEditDialog
            label={label}
            text={text}
            onClose={(next) => {
              setEditing(false);
              if (next !== text) onEdit(next);
            }}
          />
        ) : null}
      </>
    );
  }

  if (detailsMode === "popover") {
    return (
      <Popover>
        <PopoverTrigger
          render={
            <ContextChip
              kind="pasted-text"
              render={<button type="button" />}
              aria-label={`${accessibleLabel}. Show details`}
              data-markdown-copy={props.copyMarkdown}
            />
          }
        >
          <PastedTextChipContent label={label} />
        </PopoverTrigger>
        <PopoverPopup side="top" width="xl" padding="none">
          <PopoverTitle className="sr-only">{accessibleLabel}</PopoverTitle>
          <div className="overflow-hidden p-2">
            <div className="overflow-hidden rounded-md border border-border/70 bg-background/80">
              <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2">
                <ClipboardPasteIcon className="size-4 shrink-0 text-secondary-label" aria-hidden />
                <span className="min-w-0 truncate text-sm font-medium text-foreground">
                  {label}
                </span>
                <span className="ml-auto shrink-0 text-secondary-label text-xs">
                  {formatPastedTextStats(text)}
                </span>
              </div>
              <pre className={PASTED_TEXT_BODY_CLASS_NAME} aria-label="Pasted text" tabIndex={0}>
                {text}
              </pre>
            </div>
          </div>
        </PopoverPopup>
      </Popover>
    );
  }

  return (
    <ContextChipShell
      kind="pasted-text"
      icon={<ClipboardPasteIcon />}
      label={label}
      aria-label={accessibleLabel}
      tooltip={detailsMode === "none" ? undefined : text}
    />
  );
}
