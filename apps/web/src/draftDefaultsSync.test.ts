import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { DraftId, useComposerDraftStore } from "./composerDraftStore";
import {
  captureDraftDefaultsInputSnapshot,
  isUnstartedDraft,
  syncDraftDefaultsForChangedInputs,
} from "./draftDefaultsSync";

const environmentId = EnvironmentId.make("environment-draft-defaults");
const projectId = ProjectId.make("project-draft-defaults");
const projectRef = scopeProjectRef(environmentId, projectId);
const instanceId = ProviderInstanceId.make("codex");
const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-17T00:00:00.000Z",
  models: ["old-model", "new-model"].map((slug, index) => ({
    slug,
    name: slug,
    isCustom: false,
    isDefault: index === 0,
    capabilities: {
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select" as const,
          options: [
            { id: "low", label: "Low", isDefault: true },
            { id: "high", label: "High" },
          ],
        },
      ],
    },
  })),
  slashCommands: [],
  skills: [],
};

function makeConfig(input: {
  model: "old-model" | "new-model" | null;
  effort: "low" | "high";
  runtimeMode: "approval-required" | "full-access";
}) {
  return {
    providers: [provider],
    settings: {
      ...DEFAULT_UNIFIED_SETTINGS,
      defaultModelSelection: input.model ? createModelSelection(instanceId, input.model) : null,
      providerNewThreadDefaults: {
        [instanceId]: {
          modelOptions: [{ id: "reasoningEffort", value: input.effort }],
          runtimeMode: input.runtimeMode,
        },
      },
    },
  } as unknown as ServerConfig;
}

function resetStore() {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
}

function createDraftWithModel(name: string) {
  const draftId = DraftId.make(name);
  const store = useComposerDraftStore.getState();
  store.setLogicalProjectDraftThreadId(scopedProjectKey(projectRef), projectRef, draftId, {
    threadId: ThreadId.make(`${name}-thread`),
  });
  store.setModelSelection(
    draftId,
    createModelSelection(instanceId, "old-model", [{ id: "reasoningEffort", value: "low" }]),
    { replaceOptions: true },
  );
  return draftId;
}

function syncAfterConfigChange(
  previousConfig: ServerConfig,
  currentConfig: ServerConfig,
  hasStartedSession?: () => boolean,
) {
  const previousConfigs = new Map([[environmentId, previousConfig]]);
  const currentConfigs = new Map([[environmentId, currentConfig]]);
  return syncDraftDefaultsForChangedInputs({
    previous: captureDraftDefaultsInputSnapshot(previousConfigs),
    current: captureDraftDefaultsInputSnapshot(currentConfigs),
    serverConfigs: currentConfigs,
    ...(hasStartedSession ? { hasStartedSession } : {}),
  });
}

const previousConfig = makeConfig({
  model: "old-model",
  effort: "low",
  runtimeMode: "full-access",
});
const currentConfig = makeConfig({
  model: "new-model",
  effort: "high",
  runtimeMode: "approval-required",
});

describe("draft defaults sync", () => {
  beforeEach(resetStore);

  it("treats every unpromoted local draft as unstarted", () => {
    const draftId = createDraftWithModel("unstarted-detection");
    const store = useComposerDraftStore.getState();
    expect(isUnstartedDraft(store.getDraftSession(draftId)!)).toBe(true);

    store.markDraftThreadPromoting(draftId);
    expect(isUnstartedDraft(useComposerDraftStore.getState().getDraftSession(draftId)!)).toBe(
      false,
    );
  });

  it("re-seeds model, options, and runtime mode after defaults change", () => {
    const draftId = createDraftWithModel("settings-change");

    expect(syncAfterConfigChange(previousConfig, currentConfig)).toBe(1);
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.runtimeMode).toBe(
      "approval-required",
    );
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)).toMatchObject({
      activeProvider: instanceId,
      modelSelectionByProvider: {
        [instanceId]: {
          instanceId,
          model: "new-model",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      },
    });
  });

  it("preserves a draft with a typed prompt", () => {
    const draftId = createDraftWithModel("prompt-draft");
    useComposerDraftStore.getState().setPrompt(draftId, "keep this prompt");

    expect(syncAfterConfigChange(previousConfig, currentConfig)).toBe(0);
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)).toMatchObject({
      prompt: "keep this prompt",
      modelSelectionByProvider: {
        [instanceId]: { model: "old-model" },
      },
    });
  });

  it("does not re-seed a promoted draft", () => {
    const draftId = createDraftWithModel("promoted-draft");
    useComposerDraftStore.getState().markDraftThreadPromoting(draftId);

    expect(syncAfterConfigChange(previousConfig, currentConfig)).toBe(0);
    expect(
      useComposerDraftStore.getState().getComposerDraft(draftId)?.modelSelectionByProvider[
        instanceId
      ]?.model,
    ).toBe("old-model");
  });

  it("does not re-seed a draft with a started server session", () => {
    const draftId = createDraftWithModel("started-draft");

    expect(syncAfterConfigChange(previousConfig, currentConfig, () => true)).toBe(0);
    expect(
      useComposerDraftStore.getState().getComposerDraft(draftId)?.modelSelectionByProvider[
        instanceId
      ]?.model,
    ).toBe("old-model");
  });

  it("does not re-seed when settings are unchanged", () => {
    const draftId = createDraftWithModel("unchanged-settings");
    const configs = new Map([[environmentId, previousConfig]]);
    const snapshot = captureDraftDefaultsInputSnapshot(configs);
    useComposerDraftStore
      .getState()
      .setStickyModelSelection(createModelSelection(instanceId, "new-model"));

    expect(
      syncDraftDefaultsForChangedInputs({
        previous: snapshot,
        current: snapshot,
        serverConfigs: configs,
      }),
    ).toBe(0);
    expect(
      useComposerDraftStore.getState().getComposerDraft(draftId)?.modelSelectionByProvider[
        instanceId
      ]?.model,
    ).toBe("old-model");
  });
});

it("preserves explicit model and permission choices", () => {
  for (const choice of ["model", "permission"] as const) {
    resetStore();
    const draftId = createDraftWithModel(choice);
    const store = useComposerDraftStore.getState();
    if (choice === "model")
      store.setModelSelection(draftId, createModelSelection(instanceId, "old-model"), {
        explicit: true,
      });
    else store.setRuntimeMode(draftId, "auto-accept-edits");
    expect(syncAfterConfigChange(previousConfig, currentConfig)).toBe(0);
  }
});

it("keeps the draft's provider model when only traits change", () => {
  resetStore();
  const draftId = createDraftWithModel("traits-only");
  const next = makeConfig({ model: "old-model", effort: "high", runtimeMode: "approval-required" });
  expect(syncAfterConfigChange(previousConfig, next)).toBe(1);
  expect(
    useComposerDraftStore.getState().getComposerDraft(draftId)?.modelSelectionByProvider[
      instanceId
    ],
  ).toMatchObject({ model: "old-model", options: [{ id: "reasoningEffort", value: "high" }] });
});

it("preserves attachments and their draft choices", () => {
  resetStore();
  const draftId = createDraftWithModel("attachment");
  useComposerDraftStore.getState().addImage(draftId, {
    type: "image",
    id: "image",
    name: "image.png",
    mimeType: "image/png",
    sizeBytes: 1,
    previewUrl: "blob:test-image",
    file: new File(["a"], "image.png", { type: "image/png" }),
  });
  expect(syncAfterConfigChange(previousConfig, currentConfig)).toBe(0);
  expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.images).toHaveLength(1);
});

it("ignores another provider's defaults", () => {
  resetStore();
  const draftId = createDraftWithModel("other-provider");
  const next = {
    ...previousConfig,
    settings: {
      ...previousConfig.settings,
      providerNewThreadDefaults: {
        ...previousConfig.settings.providerNewThreadDefaults,
        other: { runtimeMode: "auto" as const },
      },
    },
  };
  expect(syncAfterConfigChange(previousConfig, next)).toBe(0);
  expect(
    useComposerDraftStore.getState().getComposerDraft(draftId)?.modelSelectionByProvider[instanceId]
      ?.model,
  ).toBe("old-model");
});

it("uses project overrides when defaults change", () => {
  resetStore();
  const draftId = createDraftWithModel("project-defaults");
  const next = {
    ...currentConfig,
    settings: {
      ...currentConfig.settings,
      projectSettingsOverrides: {
        [projectId]: {
          defaultModelSelection: createModelSelection(instanceId, "old-model", [
            { id: "reasoningEffort", value: "low" },
          ]),
          defaultRuntimeMode: "auto" as const,
        },
      },
    },
  };
  expect(syncAfterConfigChange(previousConfig, next)).toBe(1);
  expect(useComposerDraftStore.getState().getDraftSession(draftId)?.runtimeMode).toBe("auto");
  expect(
    useComposerDraftStore.getState().getComposerDraft(draftId)?.modelSelectionByProvider[
      instanceId
    ],
  ).toEqual(next.settings.projectSettingsOverrides[projectId]!.defaultModelSelection);
});

it("returns to the last-used model when the fixed model is reset", () => {
  resetStore();
  const draftId = createDraftWithModel("last-used");
  useComposerDraftStore
    .getState()
    .setStickyModelSelection(createModelSelection(instanceId, "new-model"));
  expect(
    syncAfterConfigChange(
      previousConfig,
      makeConfig({ model: null, effort: "high", runtimeMode: "full-access" }),
    ),
  ).toBe(1);
  expect(
    useComposerDraftStore.getState().getComposerDraft(draftId)?.modelSelectionByProvider[instanceId]
      ?.model,
  ).toBe("new-model");
});
