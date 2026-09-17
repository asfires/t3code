import { describe, expect, it } from "vite-plus/test";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import {
  pastedTextContextRecord,
  pastedTextContextReference,
} from "../../lib/composerContextRecords";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import { restoreComposerPrompt } from "./composerPromptRecovery";

describe("restoreComposerPrompt", () => {
  it("gives a rewound paste a fresh identity so an edited draft with the same id survives", () => {
    const original = {
      id: "paste",
      text: "original pasted contents",
      createdAt: "2026-09-17T12:00:00.000Z",
    };
    const chip = formatInlineContextReference(pastedTextContextReference(original));
    const restored = restoreComposerPrompt(
      {
        text: `before ${chip} then ${chip}`,
        context: { version: 1, records: [pastedTextContextRecord(original)] },
      },
      () => "restored-paste",
    );
    expect(restored.pastedTexts).toHaveLength(1);
    expect(restored.prompt.match(/pasted-text_restored-paste/g)).toHaveLength(2);
    const outgoing = projectComposerContextForProvider({
      text: `${chip}\n\n${restored.prompt}`,
      records: [
        pastedTextContextRecord({ ...original, text: "unsent edited contents" }),
        ...restored.pastedTexts.map(pastedTextContextRecord),
      ],
    });
    expect(outgoing).toContain("unsent edited contents");
    expect(outgoing).toContain(original.text);
    expect(outgoing).not.toContain('unavailable="true"');
  });
});
