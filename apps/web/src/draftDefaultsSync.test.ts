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
      newThreadModel: input.model ? createModelSelection(instanceId, input.model) : null,
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
