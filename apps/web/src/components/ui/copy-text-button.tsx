import { CheckIcon, CopyIcon } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "~/lib/utils";
import { Button } from "./button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

export interface CopyTextMenuItem {
  text: string;
  label: string;
  onCopyError?: (cause: unknown) => void;
}

function useCopyTextFeedback() {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copyText = useCallback((item: CopyTextMenuItem) => {
    if (typeof navigator === "undefined" || navigator.clipboard == null) {
      return;
    }
    void navigator.clipboard
      .writeText(item.text)
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
        item.onCopyError?.(cause);
      });
  }, []);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  return { copied, copyText };
}

export const CopyTextButton = memo(function CopyTextButton(props: {
  text: string;
  label: string;
  copiedLabel?: string;
  className?: string;
  icon?: ReactNode;
  onCopyError?: (cause: unknown) => void;
}) {
  const { text, label, copiedLabel = "Copied", className, icon, onCopyError } = props;
  const { copied, copyText } = useCopyTextFeedback();
  const currentLabel = copied ? copiedLabel : label;

  const handleCopy = useCallback(() => {
    copyText({ text, label, ...(onCopyError ? { onCopyError } : {}) });
  }, [copyText, label, onCopyError, text]);

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

export const CopyTextMenuButton = memo(function CopyTextMenuButton(props: {
  items: readonly CopyTextMenuItem[];
  label: string;
  copiedLabel?: string;
  className?: string;
  icon?: ReactNode;
}) {
  const { items, label, copiedLabel = "Copied", className, icon } = props;
  const { copied, copyText } = useCopyTextFeedback();
  const currentLabel = copied ? copiedLabel : label;

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className={cn("text-muted-foreground hover:text-foreground", className)}
                  aria-label={currentLabel}
                />
              }
            />
          }
        >
          {copied ? <CheckIcon className="size-3" /> : (icon ?? <CopyIcon className="size-3" />)}
        </TooltipTrigger>
        <TooltipPopup side="top">{currentLabel}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end">
        {items.map((item) => (
          <MenuItem key={item.label} onClick={() => copyText(item)}>
            {item.label}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
});
