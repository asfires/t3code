import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  createEditor,
  PASTE_COMMAND,
} from "lexical";
import { serializePastedText } from "@t3tools/shared/pastedText";

import { registerComposerInlineTokenPaste } from "./composerInlineTokenPaste";
import {
  $createComposerPastedTextNode,
  ComposerPastedTextNode,
  isComposerPromptEditorBeyondMinimumHeight,
} from "./ComposerPromptEditor";

describe("isComposerPromptEditorBeyondMinimumHeight", () => {
  it("reports the first physical height increase beyond the editor minimum", () => {
    expect(isComposerPromptEditorBeyondMinimumHeight({ clientHeight: 70 }, 70)).toBe(false);
    expect(isComposerPromptEditorBeyondMinimumHeight({ clientHeight: 71 }, 70)).toBe(false);
    expect(isComposerPromptEditorBeyondMinimumHeight({ clientHeight: 92 }, 70)).toBe(true);
  });
});

describe("ComposerPastedTextNode", () => {
  it("updates the serialized prompt when its expanded editor changes", () => {
    const editor = createEditor({ nodes: [ComposerPastedTextNode] });
    let nodeKey = "";

    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        $getRoot().append(paragraph);
        const pastedText = $createComposerPastedTextNode("original pasted text");
        paragraph.append(pastedText);
        nodeKey = pastedText.getKey();
      },
      { discrete: true },
    );
    editor.update(
      () => {
        const pastedText = $getNodeByKey(nodeKey);
        expect(pastedText).toBeInstanceOf(ComposerPastedTextNode);
        if (pastedText instanceof ComposerPastedTextNode) {
          pastedText.setText("edited pasted text");
        }
      },
      { discrete: true },
    );

    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe(
      serializePastedText("edited pasted text"),
    );
  });

  it("removes the pasted-text block when its expanded editor is cleared", () => {
    const editor = createEditor({ nodes: [ComposerPastedTextNode] });
    let nodeKey = "";
    let retainedNodeKey = "";

    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        $getRoot().append(paragraph);
        const pastedText = $createComposerPastedTextNode("delete all of this");
        const retainedPastedText = $createComposerPastedTextNode("keep this block");
        paragraph.append(pastedText, retainedPastedText);
        nodeKey = pastedText.getKey();
        retainedNodeKey = retainedPastedText.getKey();
      },
      { discrete: true },
    );
    editor.update(
      () => {
        const pastedText = $getNodeByKey(nodeKey);
        expect(pastedText).toBeInstanceOf(ComposerPastedTextNode);
        if (pastedText instanceof ComposerPastedTextNode) {
          pastedText.setText("");
        }
      },
      { discrete: true },
    );

    editor.getEditorState().read(() => {
      expect($getNodeByKey(nodeKey)).toBeNull();
      expect($getNodeByKey(retainedNodeKey)).toBeInstanceOf(ComposerPastedTextNode);
      expect($getRoot().getTextContent()).toBe(serializePastedText("keep this block"));
    });
  });
});

class TestClipboardEvent extends Event {
  readonly clipboardData: DataTransfer;

  constructor(text: string) {
    super("paste", { cancelable: true });
    this.clipboardData = {
      files: [],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    } as unknown as DataTransfer;
  }
}

describe("registerComposerInlineTokenPaste", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("handles a copied mention without also running the plain-text paste fallback", () => {
    vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
    const editor = createEditor();
    const mention = "[improve-deploy-error-logging.md](.changeset/improve-deploy-error-logging.md)";
    const plainTextFallback = vi.fn(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;
      selection.insertText(mention);
      return true;
    });

    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        $getRoot().append(paragraph);
        paragraph.selectEnd();
      },
      { discrete: true },
    );
    registerComposerInlineTokenPaste(editor, {
      createMentionNode: (path) => $createTextNode(`<mention:${path}>`),
      createPastedTextNode: (text) => $createTextNode(`<paste:${text}>`),
      getExpandedAbsoluteOffsetForPoint: () => 0,
    });
    editor.registerCommand(PASTE_COMMAND, plainTextFallback, COMMAND_PRIORITY_EDITOR);

    const event = new TestClipboardEvent(mention);
    let handled = false;
    editor.update(
      () => {
        handled = editor.dispatchCommand(PASTE_COMMAND, event as ClipboardEvent);
      },
      { discrete: true },
    );

    expect(handled).toBe(true);
    expect(plainTextFallback).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe(
      "<mention:.changeset/improve-deploy-error-logging.md> ",
    );
  });

  it.each([
    "yarn expo install @expo/ui",
    "npm install @jane/foo.js",
    "import '@scope/pkg/sub/path'",
  ])("leaves scoped package command %s to the plain-text paste fallback", (command) => {
    vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
    const editor = createEditor();
    const plainTextFallback = vi.fn((event: ClipboardEvent) => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return false;
      selection.insertText(event.clipboardData?.getData("text/plain") ?? "");
      return true;
    });

    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        $getRoot().append(paragraph);
        paragraph.selectEnd();
      },
      { discrete: true },
    );
    registerComposerInlineTokenPaste(editor, {
      createMentionNode: (path) => $createTextNode(`<mention:${path}>`),
      createPastedTextNode: (text) => $createTextNode(`<paste:${text}>`),
      getExpandedAbsoluteOffsetForPoint: () => 0,
    });
    editor.registerCommand(PASTE_COMMAND, plainTextFallback, COMMAND_PRIORITY_EDITOR);

    const event = new TestClipboardEvent(command);
    let handled = false;
    editor.update(
      () => {
        handled = editor.dispatchCommand(PASTE_COMMAND, event as ClipboardEvent);
      },
      { discrete: true },
    );

    expect(handled).toBe(true);
    expect(plainTextFallback).toHaveBeenCalledOnce();
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe(command);
  });

  it("pastes a canonical scoped folder link as a mention", () => {
    vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
    const editor = createEditor();
    const mention = "[sub](@scope/pkg/sub)";
    const plainTextFallback = vi.fn(() => true);

    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        $getRoot().append(paragraph);
        paragraph.selectEnd();
      },
      { discrete: true },
    );
    registerComposerInlineTokenPaste(editor, {
      createMentionNode: (path) => $createTextNode(`<mention:${path}>`),
      createPastedTextNode: (text) => $createTextNode(`<paste:${text}>`),
      getExpandedAbsoluteOffsetForPoint: () => 0,
    });
    editor.registerCommand(PASTE_COMMAND, plainTextFallback, COMMAND_PRIORITY_EDITOR);

    const event = new TestClipboardEvent(mention);
    let handled = false;
    editor.update(
      () => {
        handled = editor.dispatchCommand(PASTE_COMMAND, event as ClipboardEvent);
      },
      { discrete: true },
    );

    expect(handled).toBe(true);
    expect(plainTextFallback).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe(
      "<mention:@scope/pkg/sub> ",
    );
  });

  it("turns a large plain-text paste into one atomic presentation node", () => {
    vi.stubGlobal("ClipboardEvent", TestClipboardEvent);
    const editor = createEditor();
    const pastedText = "line of pasted text\n".repeat(20);
    const plainTextFallback = vi.fn(() => true);

    editor.update(
      () => {
        const paragraph = $createParagraphNode();
        $getRoot().append(paragraph);
        paragraph.selectEnd();
      },
      { discrete: true },
    );
    registerComposerInlineTokenPaste(editor, {
      createMentionNode: (path) => $createTextNode(`<mention:${path}>`),
      createPastedTextNode: (text) => $createTextNode(`<paste:${text}>`),
      getExpandedAbsoluteOffsetForPoint: () => 0,
    });
    editor.registerCommand(PASTE_COMMAND, plainTextFallback, COMMAND_PRIORITY_EDITOR);

    const event = new TestClipboardEvent(pastedText);
    editor.update(() => editor.dispatchCommand(PASTE_COMMAND, event as ClipboardEvent), {
      discrete: true,
    });

    expect(plainTextFallback).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe(
      `<paste:${pastedText}>`,
    );
  });
});
