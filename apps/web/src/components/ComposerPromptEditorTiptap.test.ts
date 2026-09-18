import { describe, expect, it } from "vite-plus/test";
import { isComposerPromptEditorBeyondMinimumHeight } from "./ComposerPromptEditor";

describe("isComposerPromptEditorBeyondMinimumHeight", () => {
  it("reports the first physical height increase beyond the editor minimum", () => {
    expect(isComposerPromptEditorBeyondMinimumHeight({ clientHeight: 70 }, 70)).toBe(false);
    expect(isComposerPromptEditorBeyondMinimumHeight({ clientHeight: 71 }, 70)).toBe(false);
    expect(isComposerPromptEditorBeyondMinimumHeight({ clientHeight: 92 }, 70)).toBe(true);
  });
});
