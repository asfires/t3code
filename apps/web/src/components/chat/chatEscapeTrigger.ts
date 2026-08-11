export const CHAT_FLOATING_LAYER_SELECTOR = [
  '[data-slot="popover-popup"]',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
].join(",");

const handledChatEscapeEvents = new WeakSet<KeyboardEvent>();

/** Allows a chat surface that handles Escape without preventing default to opt out. */
export function markChatEscapeHandled(event: KeyboardEvent): void {
  handledChatEscapeEvents.add(event);
}

export function isTextEditingTargetOutsideComposer(target: EventTarget | null): boolean {
  if (typeof Element === "undefined") return false;
  if (!(target instanceof Element)) return false;
  if (target.closest('[data-chat-composer-overlay="true"]')) return false;
  if (target.closest("input, textarea")) return true;
  return target.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

export function shouldHandleChatEscape(input: {
  event: KeyboardEvent;
  terminalFocused: boolean;
  commandPaletteOpen: boolean;
  composerEscapeGateOpen: boolean;
  floatingLayerOpen: boolean;
  textEditingTargetOutsideComposer?: boolean;
}): boolean {
  const { event } = input;
  if (event.key !== "Escape" || event.isComposing) return false;
  if (event.defaultPrevented || event.cancelBubble || handledChatEscapeEvents.has(event)) {
    return false;
  }
  if (
    input.terminalFocused ||
    input.commandPaletteOpen ||
    input.composerEscapeGateOpen ||
    input.floatingLayerOpen
  ) {
    return false;
  }
  return !(
    input.textEditingTargetOutsideComposer ?? isTextEditingTargetOutsideComposer(event.target)
  );
}
