import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS, ProjectId } from "@t3tools/contracts";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";

import {
  resolveNewThreadConfiguredState,
  resolveProjectSettings,
  resolveProviderNewThreadDefaults,
} from "./projectSettings.ts";

const codexId = ProviderInstanceId.make("codex");
const claudeId = ProviderInstanceId.make("claudeAgent");

function provider(input: {
  readonly instanceId: typeof codexId;
  readonly driver: string;
  readonly model: string;
  readonly enabled?: boolean;
}): ServerProvider {
  return {
    instanceId: input.instanceId,
    driver: ProviderDriverKind.make(input.driver),
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [
      {
        slug: input.model,
        name: input.model,
        isCustom: false,
        isDefault: true,
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              options: [
                { id: "low", label: "Low", isDefault: true },
                { id: "high", label: "High" },
              ],
            },
          ],
        },
      },
    ],
    slashCommands: [],
    skills: [],
  };
}

const providers = [
  provider({ instanceId: codexId, driver: "codex", model: "gpt" }),
  provider({ instanceId: claudeId, driver: "claudeAgent", model: "claude" }),
];
const selection = (instanceId: typeof codexId, model: string): ModelSelection => ({
  instanceId,
  model,
});
const settings = {
  providerNewThreadDefaults: {
    [claudeId]: {
      modelOptions: [{ id: "effort", value: "high" }],
      runtimeMode: "approval-required" as const,
    },
  },
};

function resolve(input: {
  projectDefaultModel?: ModelSelection | null;
  configuredModel?: ModelSelection | null;
  carryModel?: ModelSelection | null;
  providersOverride?: ReadonlyArray<ServerProvider>;
}) {
  return resolveNewThreadConfiguredState({
    projectSettings: resolveProjectSettings(
      {
        ...DEFAULT_SERVER_SETTINGS,
        ...settings,
        defaultModelSelection: input.configuredModel ?? null,
        projectSettingsOverrides: input.projectDefaultModel
          ? { [ProjectId.make("project")]: { defaultModelSelection: input.projectDefaultModel } }
          : {},
      },
      ProjectId.make("project"),
    ),
    carryModel: input.carryModel ?? null,
    stickyModel: selection(codexId, "gpt"),
    providers: input.providersOverride ?? providers,
  });
}

describe("new-thread model defaults", () => {
  it("honors project model options before provider defaults", () => {
    const projectDefaultModel = {
      ...selection(claudeId, "claude"),
      options: [{ id: "effort", value: "low" }],
    };
    expect(resolve({ projectDefaultModel, configuredModel: selection(codexId, "gpt") })).toEqual({
      modelSelection: projectDefaultModel,
      runtimeMode: "approval-required",
    });
  });
  it("uses Always model before carry and sticky, with configured options and runtime mode", () => {
    const result = resolve({
      configuredModel: selection(claudeId, "claude"),
      carryModel: selection(codexId, "gpt"),
    });

    expect(result).toEqual({
      modelSelection: {
        instanceId: claudeId,
        model: "claude",
        options: [{ id: "effort", value: "high" }],
      },
      runtimeMode: "approval-required",
    });
  });

  it("keeps the last-used carry path when Always is null", () => {
    expect(resolve({ carryModel: selection(claudeId, "claude") }).modelSelection?.instanceId).toBe(
      claudeId,
    );
  });

  it("falls through when the configured instance is disabled", () => {
    const disabledProviders = [providers[0]!, { ...providers[1]!, enabled: false }];
    expect(
      resolve({
        configuredModel: selection(claudeId, "claude"),
        carryModel: selection(codexId, "gpt"),
        providersOverride: disabledProviders,
      }).modelSelection?.instanceId,
    ).toBe(codexId);
  });
});

describe("project and provider precedence", () => {
  it("uses project permission mode ahead of provider defaults", () => {
    const projectSettings = resolveProjectSettings(
      {
        ...DEFAULT_SERVER_SETTINGS,
        ...settings,
        defaultRuntimeMode: "auto",
        projectSettingsOverrides: {
          [ProjectId.make("project")]: { defaultRuntimeMode: "auto-accept-edits" },
        },
      },
      ProjectId.make("project"),
    );
    expect(
      resolveProviderNewThreadDefaults({
        projectSettings,
        modelSelection: selection(claudeId, "claude"),
        providers,
      }).runtimeMode,
    ).toBe("auto-accept-edits");
  });

  it("uses last-used traits and global permission mode when provider defaults are absent", () => {
    const lastUsedOptions = [{ id: "effort", value: "high" }];
    const projectSettings = resolveProjectSettings(
      { ...DEFAULT_SERVER_SETTINGS, defaultRuntimeMode: "auto" },
      null,
    );
    expect(
      resolveProviderNewThreadDefaults({
        projectSettings,
        modelSelection: selection(codexId, "gpt"),
        providers,
        lastUsedOptions,
      }),
    ).toEqual({
      modelSelection: { ...selection(codexId, "gpt"), options: lastUsedOptions },
      runtimeMode: "auto",
    });
  });

  it("ignores global model traits and another provider's project traits", () => {
    const projectSettings = resolveProjectSettings(
      {
        ...DEFAULT_SERVER_SETTINGS,
        ...settings,
        defaultModelSelection: {
          ...selection(claudeId, "claude"),
          options: [{ id: "effort", value: "low" }],
        },
      },
      null,
    );
    expect(
      resolveProviderNewThreadDefaults({
        projectSettings,
        modelSelection: selection(claudeId, "claude"),
        providers,
      }).modelSelection.options,
    ).toEqual([{ id: "effort", value: "high" }]);
    const otherProject = resolveProjectSettings(
      {
        ...projectSettings.settings,
        projectSettingsOverrides: {
          [ProjectId.make("project")]: {
            defaultModelSelection: {
              ...selection(codexId, "gpt"),
              options: [{ id: "effort", value: "low" }],
            },
          },
        },
      },
      ProjectId.make("project"),
    );
    expect(
      resolveProviderNewThreadDefaults({
        projectSettings: otherProject,
        modelSelection: selection(claudeId, "claude"),
        providers,
      }).modelSelection.options,
    ).toEqual([{ id: "effort", value: "high" }]);
  });
});

it("honors project provider enablement when selecting a default model", () => {
  const projectId = ProjectId.make("project");
  const projectSettings = resolveProjectSettings(
    {
      ...DEFAULT_SERVER_SETTINGS,
      ...settings,
      defaultModelSelection: selection(claudeId, "claude"),
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [claudeId]: { enabled: false } } },
      },
    },
    projectId,
  );
  expect(
    resolveNewThreadConfiguredState({ projectSettings, providers }).modelSelection?.instanceId,
  ).toBe(codexId);
});
