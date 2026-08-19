import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import { useEffect, useRef } from "react";
import { DraftId, type DraftSessionState, useComposerDraftStore } from "./composerDraftStore";
import { resolveNewThreadConfiguredState } from "./hooks/useHandleNewThread";
import { readThreadShell, useServerConfigs } from "./state/entities";

export interface DraftDefaultsInputSnapshot {
  readonly settingsByEnvironment: ReadonlyMap<EnvironmentId, string>;
}

export function captureDraftDefaultsInputSnapshot(
  serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>,
): DraftDefaultsInputSnapshot {
  return {
    settingsByEnvironment: new Map(
      Array.from(serverConfigs, ([environmentId, config]) => [
        environmentId,
        JSON.stringify({
          newThreadModel: config.settings.newThreadModel,
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
    const resolved = resolveNewThreadConfiguredState({
      configuredModel: serverConfig.settings.newThreadModel,
      carryModel: null,
      stickyActiveProvider: stickySelection,
      providers: serverConfig.providers,
      settings: serverConfig.settings,
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
    latestStore.setRuntimeMode(draftId, resolved.runtimeMode);
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
      serverConfigs,
      hasStartedSession: (environmentId, threadId) =>
        readThreadShell(scopeThreadRef(environmentId, threadId)) !== null,
    });
  }, [serverConfigs]);

  return null;
}
