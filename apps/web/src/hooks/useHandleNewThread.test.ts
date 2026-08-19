import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveNewThreadConfiguredState } from "./useHandleNewThread";

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
  configuredModel?: ModelSelection | null;
  carryModel?: ModelSelection | null;
  providersOverride?: ReadonlyArray<ServerProvider>;
}) {
  return resolveNewThreadConfiguredState({
    configuredModel: input.configuredModel ?? null,
    carryModel: input.carryModel ?? null,
    stickyActiveProvider: selection(codexId, "gpt"),
    providers: input.providersOverride ?? providers,
    settings,
  });
}

describe("new-thread model defaults", () => {
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
