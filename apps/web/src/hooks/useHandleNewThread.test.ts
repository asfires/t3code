import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";

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
  projectDefaultModel?: ModelSelection | null;
  configuredModel?: ModelSelection | null;
  carryModel?: ModelSelection | null;
  providersOverride?: ReadonlyArray<ServerProvider>;
}) {
  return resolveNewThreadConfiguredState({
    projectDefaultModel: input.projectDefaultModel,
    configuredModel: input.configuredModel ?? null,
    carryModel: input.carryModel ?? null,
    stickyActiveProvider: selection(codexId, "gpt"),
    providers: input.providersOverride ?? providers,
    settings,
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

import { describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => {
  let completeProjectFileRead: (value: null) => void = () => undefined;
  let projectFileRead = Promise.resolve<null>(null);
  let storedDraft: {
    readonly draftId: string;
    readonly environmentId: string;
    readonly promotedTo: null;
    readonly threadId: string;
  } | null = null;
  const router = {
    state: {
      location: { href: "/" },
      matches: [{ params: {} }],
    },
    navigate: vi.fn(async (request: { readonly params: { readonly draftId: string } }) => {
      router.state.location.href = `/draft/${request.params.draftId}`;
    }),
  };
  const draftStore = {
    getComposerDraft: vi.fn(() => ({})),
    getDraftSessionByLogicalProjectKey: vi.fn(() => storedDraft),
    getDraftSession: vi.fn(() => null),
    getDraftThread: vi.fn(() => null),
    applyStickyState: vi.fn(),
    setDraftThreadContext: vi.fn(),
    setLogicalProjectDraftThreadId: vi.fn(),
    setModelSelection: vi.fn(),
  };

  return {
    completeProjectFileRead: (value: null) => completeProjectFileRead(value),
    draftStore,
    get projectFileRead() {
      return projectFileRead;
    },
    reset(nextStoredDraft: typeof storedDraft) {
      storedDraft = nextStoredDraft;
      router.state.location.href = "/";
      router.navigate.mockClear();
      draftStore.setLogicalProjectDraftThreadId.mockClear();
      projectFileRead = new Promise<null>((resolve) => {
        completeProjectFileRead = resolve;
      });
    },
    router,
  };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({
    providerNewThreadDefaults: {},
    defaultThreadEnvMode: "local",
    newWorktreesStartFromOrigin: false,
  }),
}));
vi.mock("@t3tools/client-runtime/environment", () => ({
  scopedProjectKey: () => "remote-project",
  scopeProjectRef: (environmentId: string, projectId: string) => ({ environmentId, projectId }),
  scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
}));

vi.mock("@t3tools/shared/threadEnvMode", () => ({
  resolveDefaultThreadEnvMode: (input: {
    readonly projectFile: "local" | "worktree" | null;
    readonly globalDefault: "local" | "worktree";
  }) => input.projectFile ?? input.globalDefault,
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => null,
  useRouter: () => testState.router,
}));
vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
}));
vi.mock("../components/Sidebar.logic", () => ({ orderItemsByPreferredIds: () => [] }));
vi.mock("../composerDraftStore", () => {
  const useComposerDraftStore = Object.assign(() => null, {
    getState: () => testState.draftStore,
  });
  return {
    composerDraftHasUserContent: () => false,
    markPromotedDraftThreadByRef: vi.fn(),
    useComposerDraftStore,
  };
});
vi.mock("../lib/chatThreadActions", () => ({
  hasExplicitComposerModelSelection: () => false,
  resolveNewDraftStartFromOrigin: () => false,
  resolveNewThreadModelSelectionOverride: () => null,
}));
vi.mock("../lib/t3ProjectFileDefaults", () => ({
  readT3ProjectFileDefaultThreadEnvMode: () => testState.projectFileRead,
}));
vi.mock("../lib/utils", () => ({
  newDraftId: () => "draft-delayed",
  newThreadId: () => "thread-delayed",
}));
vi.mock("../logicalProject", () => ({
  deriveLogicalProjectKeyFromSettings: () => "remote-project",
  getProjectOrderKey: () => "remote-project",
  selectProjectGroupingSettings: () => ({}),
}));
vi.mock("../state/entities", () => ({
  readProjects: () => [
    {
      id: "project-remote",
      environmentId: "environment-ssh",
      workspaceRoot: "/remote/project",
      defaultThreadEnvMode: null,
      defaultModelSelection: null,
    },
  ],
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
  useThread: () => null,
}));
vi.mock("../state/server", () => ({ primaryServerSettingsAtom: {} }));
vi.mock("../threadRoutes", () => ({ resolveThreadRouteTarget: () => null }));
vi.mock("../uiStateStore", () => ({
  legacyProjectCwdPreferenceKey: () => "remote-project",
  useUiStateStore: () => [],
}));
vi.mock("./useSettings", () => ({ useClientSettings: () => ({}) }));

import { useNewThreadHandler } from "./useHandleNewThread";

describe("useNewThreadHandler", () => {
  it.each([
    ["new", null],
    [
      "reusable",
      {
        draftId: "draft-existing",
        environmentId: "environment-ssh",
        promotedTo: null,
        threadId: "thread-existing",
      },
    ],
  ])("abandons a delayed %s draft open when the user navigates elsewhere", async (_, draft) => {
    testState.reset(draft);
    const openThread = useNewThreadHandler();
    const pendingOpen = openThread(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { replace: true },
    );

    testState.router.state.location.href = "/usage";
    testState.completeProjectFileRead(null);
    await pendingOpen;

    expect(testState.router.state.location.href).toBe("/usage");
    expect(testState.router.navigate).not.toHaveBeenCalled();
    expect(testState.draftStore.setLogicalProjectDraftThreadId).not.toHaveBeenCalled();
  });
});
