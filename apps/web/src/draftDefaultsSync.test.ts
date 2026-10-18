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
  runtimeMode: "approval-required" | "auto";
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

function createDraftWithModel(name: string, ref = projectRef) {
  const draftId = DraftId.make(name);
  const store = useComposerDraftStore.getState();
  store.setLogicalProjectDraftThreadId(scopedProjectKey(ref), ref, draftId, {
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
  runtimeMode: "auto",
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
      runtimeMode: "approval-required",
      modelSelectionByProvider: {
        [instanceId]: {
          instanceId,
          model: "new-model",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      },
    });
  });

  it("re-seeds a draft with a typed prompt without changing its content", () => {
    const draftId = createDraftWithModel("prompt-draft");
    useComposerDraftStore.getState().setPrompt(draftId, "keep this prompt");

    expect(syncAfterConfigChange(previousConfig, currentConfig)).toBe(1);
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)).toMatchObject({
      prompt: "keep this prompt",
      runtimeMode: "approval-required",
      modelSelectionByProvider: {
        [instanceId]: { model: "new-model" },
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

it.each(["model", "traits", "permission"] as const)("re-seeds explicit %s choices", (choice) => {
  resetStore();
  const draftId = createDraftWithModel(choice);
  const store = useComposerDraftStore.getState();
  if (choice === "model") {
    store.setModelSelection(draftId, createModelSelection(instanceId, "old-model"), {
      explicit: true,
    });
  } else if (choice === "traits") {
    store.setProviderModelOptions(draftId, provider.driver, [
      { id: "reasoningEffort", value: "low" },
    ]);
  } else {
    store.setRuntimeMode(draftId, "auto-accept-edits");
  }
  expect(syncAfterConfigChange(previousConfig, currentConfig)).toBe(1);
  expect(useComposerDraftStore.getState().getComposerDraft(draftId)).toMatchObject({
    runtimeMode: "approval-required",
    modelSelectionByProvider: {
      [instanceId]: {
        model: "new-model",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    },
  });
});

it("re-seeds the model as well when only traits change", () => {
  resetStore();
  const draftId = createDraftWithModel("traits-only");
  useComposerDraftStore
    .getState()
    .setModelSelection(draftId, createModelSelection(instanceId, "new-model"), { explicit: true });
  const next = makeConfig({ model: "old-model", effort: "high", runtimeMode: "auto" });
  expect(syncAfterConfigChange(previousConfig, next)).toBe(1);
  expect(
    useComposerDraftStore.getState().getComposerDraft(draftId)?.modelSelectionByProvider[
      instanceId
    ],
  ).toMatchObject({ model: "old-model", options: [{ id: "reasoningEffort", value: "high" }] });
});

it("re-seeds a draft without changing its attachments", () => {
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
  const images = useComposerDraftStore.getState().getComposerDraft(draftId)?.images;
  expect(syncAfterConfigChange(previousConfig, currentConfig)).toBe(1);
  expect(useComposerDraftStore.getState().getComposerDraft(draftId)).toMatchObject({
    images,
    runtimeMode: "approval-required",
    modelSelectionByProvider: {
      [instanceId]: { model: "new-model" },
    },
  });
});

it("re-seeds even when only another provider's defaults change", () => {
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
  expect(syncAfterConfigChange(previousConfig, next)).toBe(1);
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
      makeConfig({ model: null, effort: "high", runtimeMode: "auto" }),
    ),
  ).toBe(1);
  expect(
    useComposerDraftStore.getState().getComposerDraft(draftId)?.modelSelectionByProvider[instanceId]
      ?.model,
  ).toBe("new-model");
});

it("re-seeds when only the global model changes", () => {
  resetStore();
  const draftId = createDraftWithModel("global-model");
  const next = {
    ...previousConfig,
    settings: {
      ...previousConfig.settings,
      defaultModelSelection: createModelSelection(instanceId, "new-model"),
    },
  };
  expect(syncAfterConfigChange(previousConfig, next)).toBe(1);
  expect(
    useComposerDraftStore.getState().getComposerDraft(draftId)?.modelSelectionByProvider[instanceId]
      ?.model,
  ).toBe("new-model");
});

it("follows successive global runtime changes and falls back to last-used traits", () => {
  resetStore();
  const draftId = createDraftWithModel("global-runtime");
  const options = [{ id: "reasoningEffort", value: "high" }];
  useComposerDraftStore
    .getState()
    .setStickyModelSelection(createModelSelection(instanceId, "old-model", options));
  const previous = {
    ...previousConfig,
    settings: {
      ...previousConfig.settings,
      providerNewThreadDefaults: {},
      defaultRuntimeMode: "auto" as const,
    },
  };
  const next = {
    ...previous,
    settings: { ...previous.settings, defaultRuntimeMode: "approval-required" as const },
  };

  expect(syncAfterConfigChange(previous, next)).toBe(1);
  expect(useComposerDraftStore.getState().getComposerDraft(draftId)).toMatchObject({
    runtimeMode: "approval-required",
    modelSelectionByProvider: { [instanceId]: { options } },
  });
  expect(syncAfterConfigChange(next, previous)).toBe(1);
  expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.runtimeMode).toBe("auto");
  expect(useComposerDraftStore.getState().getDraftSession(draftId)?.runtimeMode).toBe("auto");
});

it("replaces stale draft traits when resolved defaults have no options", () => {
  resetStore();
  const draftId = createDraftWithModel("clear-traits");
  const next = {
    ...currentConfig,
    settings: { ...currentConfig.settings, providerNewThreadDefaults: {} },
  };
  expect(syncAfterConfigChange(previousConfig, next)).toBe(1);
  expect(
    useComposerDraftStore.getState().getComposerDraft(draftId)?.modelSelectionByProvider[
      instanceId
    ],
  ).toEqual(createModelSelection(instanceId, "new-model"));
});

it("re-seeds every unsent draft only in the changed environment", () => {
  resetStore();
  const first = createDraftWithModel("first");
  useComposerDraftStore.getState().setPrompt(first, "keep this draft");
  const second = createDraftWithModel("second");
  const otherEnvironmentId = EnvironmentId.make("other-environment");
  const other = createDraftWithModel("other", scopeProjectRef(otherEnvironmentId, projectId));
  const previous = new Map([
    [environmentId, previousConfig],
    [otherEnvironmentId, previousConfig],
  ]);
  const current = new Map([
    [environmentId, currentConfig],
    [otherEnvironmentId, previousConfig],
  ]);
  expect(
    syncDraftDefaultsForChangedInputs({
      previous: captureDraftDefaultsInputSnapshot(previous),
      current: captureDraftDefaultsInputSnapshot(current),
      serverConfigs: current,
    }),
  ).toBe(2);
  for (const draftId of [first, second]) {
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)).toMatchObject({
      runtimeMode: "approval-required",
      modelSelectionByProvider: { [instanceId]: { model: "new-model" } },
    });
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.runtimeMode).toBe(
      "approval-required",
    );
  }
  expect(
    useComposerDraftStore.getState().getComposerDraft(other)?.modelSelectionByProvider[instanceId]
      ?.model,
  ).toBe("old-model");
});
