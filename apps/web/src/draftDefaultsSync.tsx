import { appAtomRegistry } from "./rpc/atomRegistry";
import { environmentServerConfigsAtom } from "./state/server";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, type ServerSettings, type ServerConfig } from "@t3tools/contracts";
import { useEffect, useRef } from "react";
import { DraftId, type DraftSessionState, useComposerDraftStore } from "./composerDraftStore";
import {
  resolveNewThreadConfiguredState,
  resolveProjectSettings,
  resolveProviderNewThreadDefaults,
} from "@t3tools/shared/projectSettings";
import { composerDraftHasUserContent } from "./composerDraftStore";
import { readProject, readThreadShell, useServerConfigs } from "./state/entities";

export interface DraftDefaultsInputSnapshot {
  readonly previousSettings: ReadonlyMap<EnvironmentId, ServerSettings>;
  readonly settingsByEnvironment: ReadonlyMap<EnvironmentId, string>;
}

export function captureDraftDefaultsInputSnapshot(
  serverConfigs: ReadonlyMap<EnvironmentId, Pick<ServerConfig, "settings">>,
): DraftDefaultsInputSnapshot {
  return {
    previousSettings: new Map(Array.from(serverConfigs, ([id, config]) => [id, config.settings])),
    settingsByEnvironment: new Map(
      Array.from(serverConfigs, ([environmentId, config]) => [
        environmentId,
        JSON.stringify({
          defaultModelSelection: config.settings.defaultModelSelection,
          defaultRuntimeMode: config.settings.defaultRuntimeMode,
          projectSettingsOverrides: config.settings.projectSettingsOverrides,
          providerNewThreadDefaults: config.settings.providerNewThreadDefaults,
        }),
      ]),
    ),
  };
}

function storedInputChanged<TKey>(
  previous: ReadonlyMap<TKey, string>,
  current: ReadonlyMap<TKey, string>,
  key: TKey,
): boolean {
  const previousValue = previous.get(key);
  const currentValue = current.get(key);
  return (
    previousValue !== undefined && currentValue !== undefined && previousValue !== currentValue
  );
}

export function isUnstartedDraft(session: DraftSessionState): boolean {
  return session.promotedTo == null;
}

export function syncDraftDefaultsForChangedInputs(input: {
  previous: DraftDefaultsInputSnapshot;
  current: DraftDefaultsInputSnapshot;
  serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>;
  hasStartedSession?: (
    environmentId: EnvironmentId,
    threadId: DraftSessionState["threadId"],
  ) => boolean;
}): number {
  const store = useComposerDraftStore.getState();
  let reseededCount = 0;

  for (const draftKey of Object.keys(store.draftThreadsByThreadKey)) {
    const currentStore = useComposerDraftStore.getState();
    const session = currentStore.draftThreadsByThreadKey[draftKey];
    if (!session) {
      continue;
    }
    const inputsChanged = storedInputChanged(
      input.previous.settingsByEnvironment,
      input.current.settingsByEnvironment,
      session.environmentId,
    );
    if (!inputsChanged || !isUnstartedDraft(session)) {
      continue;
    }
    const composer = currentStore.getComposerDraft(DraftId.make(draftKey));
    if (
      composerDraftHasUserContent(composer) ||
      (composer?.prompt.length ?? 0) > 0 ||
      composer?.modelSelectionExplicit ||
      composer?.runtimeMode != null
    ) {
      continue;
    }
    if (input.hasStartedSession?.(session.environmentId, session.threadId) === true) {
      continue;
    }

    const serverConfig = input.serverConfigs.get(session.environmentId);
    if (!serverConfig) {
      continue;
    }

    const projectRef = scopeProjectRef(session.environmentId, session.projectId);
    const latestStore = useComposerDraftStore.getState();
    const stickySelection = latestStore.stickyActiveProvider
      ? latestStore.stickyModelSelectionByProvider[latestStore.stickyActiveProvider]
      : null;
    const project = readProject(projectRef);
    const projectSettings = resolveProjectSettings(
      serverConfig.settings,
      session.projectId,
      project,
    );
    const previousSettings = input.previous.previousSettings.get(session.environmentId)!;
    const previousProjectSettings = resolveProjectSettings(
      previousSettings,
      session.projectId,
      project,
    );
    const modelDefaultChanged =
      JSON.stringify(previousProjectSettings.settings.defaultModelSelection) !==
      JSON.stringify(projectSettings.settings.defaultModelSelection);
    const currentSelection = composer?.activeProvider
      ? composer.modelSelectionByProvider[composer.activeProvider]
      : null;
    if (!modelDefaultChanged && currentSelection) {
      const previousDefaults = resolveProviderNewThreadDefaults({
        projectSettings: previousProjectSettings,
        modelSelection: currentSelection,
        providers: serverConfig.providers,
        lastUsedOptions:
          latestStore.stickyModelSelectionByProvider[currentSelection.instanceId]?.options,
      });
      const nextDefaults = resolveProviderNewThreadDefaults({
        projectSettings,
        modelSelection: currentSelection,
        providers: serverConfig.providers,
        lastUsedOptions:
          latestStore.stickyModelSelectionByProvider[currentSelection.instanceId]?.options,
      });
      if (JSON.stringify(previousDefaults) === JSON.stringify(nextDefaults)) continue;
    }
    const resolved =
      !modelDefaultChanged && currentSelection
        ? resolveProviderNewThreadDefaults({
            projectSettings,
            modelSelection: currentSelection,
            providers: serverConfig.providers,
            lastUsedOptions:
              latestStore.stickyModelSelectionByProvider[currentSelection.instanceId]?.options,
          })
        : resolveNewThreadConfiguredState({
            projectSettings,
            carryModel: modelDefaultChanged ? null : currentSelection,
            stickyModel: stickySelection,
            stickySelections: latestStore.stickyModelSelectionByProvider,
            providers: serverConfig.providers,
          });
    const draftId = DraftId.make(draftKey);
    latestStore.setDraftThreadContext(draftId, { runtimeMode: resolved.runtimeMode });
    if (
      latestStore.logicalProjectDraftThreadKeyByLogicalProjectKey[session.logicalProjectKey] ===
      draftKey
    ) {
      latestStore.setLogicalProjectDraftThreadId(session.logicalProjectKey, projectRef, draftId, {
        threadId: session.threadId,
        createdAt: session.createdAt,
        runtimeMode: resolved.runtimeMode,
      });
    }
    if (resolved.modelSelection) {
      latestStore.setModelSelection(draftId, resolved.modelSelection, { replaceOptions: true });
    }
    reseededCount += 1;
  }

  return reseededCount;
}

export function DraftDefaultsSync() {
  const serverConfigs = useServerConfigs();
  const previousSnapshotRef = useRef<DraftDefaultsInputSnapshot | null>(null);

  useEffect(() => {
    const current = captureDraftDefaultsInputSnapshot(serverConfigs);
    const previous = previousSnapshotRef.current;
    previousSnapshotRef.current = current;
    if (!previous) {
      return;
    }
    syncDraftDefaultsForChangedInputs({
      previous,
      current,
      serverConfigs: appAtomRegistry.get(environmentServerConfigsAtom),
      hasStartedSession: (environmentId, threadId) =>
        readThreadShell(scopeThreadRef(environmentId, threadId)) !== null,
    });
  }, [serverConfigs]);

  return null;
}
