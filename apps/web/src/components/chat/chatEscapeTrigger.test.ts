import { describe, expect, it } from "vite-plus/test";

import { markChatEscapeHandled, shouldHandleChatEscape } from "./chatEscapeTrigger";

function shouldHandle(
  event: KeyboardEvent,
  overrides: Partial<Omit<Parameters<typeof shouldHandleChatEscape>[0], "event">> = {},
): boolean {
  return shouldHandleChatEscape({
    event,
    terminalFocused: false,
    commandPaletteOpen: false,
    composerEscapeGateOpen: false,
    floatingLayerOpen: false,
    ...overrides,
  });
}

function keyboardEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: "Escape",
    isComposing: false,
    defaultPrevented: false,
    cancelBubble: false,
    target: null,
    ...overrides,
  } as KeyboardEvent;
}

describe("chat Escape trigger", () => {
  it("handles an unconsumed Escape from timeline and button focus", () => {
    expect(shouldHandle(keyboardEvent())).toBe(true);
  });

  it("honors preventDefault and the handled marker", () => {
    const prevented = keyboardEvent({ defaultPrevented: true });
    expect(shouldHandle(prevented)).toBe(false);

    const marked = keyboardEvent();
    markChatEscapeHandled(marked);
    expect(shouldHandle(marked)).toBe(false);
  });

  it("defers to terminal focus, palettes, composer menus, and floating layers", () => {
    const event = keyboardEvent();

    expect(shouldHandle(event, { terminalFocused: true })).toBe(false);
    expect(shouldHandle(event, { commandPaletteOpen: true })).toBe(false);
    expect(shouldHandle(event, { composerEscapeGateOpen: true })).toBe(false);
    expect(shouldHandle(event, { floatingLayerOpen: true })).toBe(false);
  });

  it("does not take Escape from text inputs outside the composer", () => {
    expect(shouldHandle(keyboardEvent(), { textEditingTargetOutsideComposer: true })).toBe(false);
    expect(shouldHandle(keyboardEvent(), { textEditingTargetOutsideComposer: false })).toBe(true);
  });
});
