import { CheckIcon, CopyIcon } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "~/lib/utils";
import { Button } from "./button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

export const CopyTextButton = memo(function CopyTextButton(props: {
  text: string;
  label: string;
  copiedLabel?: string;
  className?: string;
  icon?: ReactNode;
  onCopyError?: (cause: unknown) => void;
}) {
  const { text, label, copiedLabel = "Copied", className, icon, onCopyError } = props;
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentLabel = copied ? copiedLabel : label;

  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || navigator.clipboard == null) {
      return;
    }
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch((cause) => {
        onCopyError?.(cause);
      });
  }, [onCopyError, text]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={cn("text-muted-foreground hover:text-foreground", className)}
            onClick={handleCopy}
            aria-label={currentLabel}
          />
        }
      >
        {copied ? <CheckIcon className="size-3" /> : (icon ?? <CopyIcon className="size-3" />)}
      </TooltipTrigger>
      <TooltipPopup side="top">{currentLabel}</TooltipPopup>
    </Tooltip>
  );
});
