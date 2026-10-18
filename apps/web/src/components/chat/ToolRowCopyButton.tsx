import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { turnItemDetailRevision } from "@t3tools/client-runtime/work-log/item-detail";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";
import { CheckIcon, CopyIcon } from "lucide-react";
import { use, useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { orchestrationEnvironment } from "../../state/orchestration";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useCommandOutputStreaming } from "./CommandOutputPanel";
import { loadToolRowCopyOutput, toolRowCopyTargets } from "./toolRowCopy";

function reportCopyError(error: unknown) {
  toastManager.add({
    type: "error",
    title: "Could not copy",
    description: error instanceof Error ? error.message : "Could not load tool output.",
  });
}

export function ToolRowCopyButton(props: {
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly environmentId: EnvironmentId;
}) {
  const registry = use(RegistryContext);
  const streamsOutput = useCommandOutputStreaming(props.environmentId);
  const [loading, setLoading] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    timeout: 1200,
    onError: reportCopyError,
  });
  const { command, output } = toolRowCopyTargets(props.projectedItem.item);
  if (!command && !output) return null;

  const copyOutput = async () => {
    setLoading(true);
    try {
      const target = {
        environmentId: props.environmentId,
        input: {
          threadId: props.projectedItem.sourceThreadId,
          itemId: props.projectedItem.sourceItemId,
        },
      };
      const text = await loadToolRowCopyOutput(
        async () => {
          const atom = orchestrationEnvironment.turnItem({
            ...target,
            input: {
              ...target.input,
              revision: turnItemDetailRevision(props.projectedItem.item),
            },
          });
          // Running items share a revision, so a previous expansion may have cached older output.
          registry.refresh(atom);
          const detail = await Effect.runPromise(
            AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }),
          );
          return detail.item;
        },
        streamsOutput
          ? async () => {
              const view = await Effect.runPromise(
                AtomRegistry.getResult(
                  registry,
                  orchestrationEnvironment.v2.commandOutput(target),
                  {
                    suspendOnWaiting: true,
                  },
                ),
              );
              return view.output;
            }
          : undefined,
      );
      copyToClipboard(text, undefined);
    } catch (error) {
      reportCopyError(error);
    } finally {
      setLoading(false);
    }
  };
  const label = isCopied
    ? "Copied"
    : command && output
      ? "Copy command or output"
      : command
        ? "Copy command"
        : "Copy output";
  const button = (
    <Button variant="ghost-muted" size="icon-xs" aria-label={label} disabled={loading} />
  );
  const icon = isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />;
  const control =
    command && output ? (
      <Menu>
        <Tooltip>
          <TooltipTrigger render={<MenuTrigger render={button} />}>{icon}</TooltipTrigger>
          <TooltipPopup side="top">{label}</TooltipPopup>
        </Tooltip>
        <MenuPopup align="end">
          <MenuItem onClick={() => copyToClipboard(command, undefined)}>Copy command</MenuItem>
          <MenuItem onClick={() => void copyOutput()}>Copy output</MenuItem>
        </MenuPopup>
      </Menu>
    ) : (
      <Tooltip>
        <TooltipTrigger
          render={button}
          onClick={() => (command ? copyToClipboard(command, undefined) : void copyOutput())}
        >
          {icon}
        </TooltipTrigger>
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    );
  return (
    <span
      className="shrink-0 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover/timeline-row:opacity-100 has-[[data-popup-open]]:opacity-100"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {control}
    </span>
  );
}
