import { useAtomValue } from "@effect/atom-react";
import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  DEFAULT_RUNTIME_MODE,
  type ModelSelection,
  type ScopedProjectRef,
  type ServerProvider,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";
import { useParams, useRouter } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import {
  composerDraftHasUserContent,
  markPromotedDraftThreadByRef,
  type DraftId,
  type DraftThreadEnvMode,
  type DraftThreadState,
  useComposerDraftStore,
} from "../composerDraftStore";
import { newDraftId, newThreadId } from "../lib/utils";
import { orderItemsByPreferredIds } from "../components/Sidebar.logic";
import {
  deriveLogicalProjectKeyFromSettings,
  getProjectOrderKey,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { resolveDefaultThreadEnvMode } from "@t3tools/shared/threadEnvMode";
import {
  createModelSelection,
  resolveConfiguredProviderOptionDefaults,
  resolveConfiguredRuntimeMode,
} from "@t3tools/shared/model";
import { readThreadShell, useProjects, useServerConfigs, useThread } from "../state/entities";
import { resolveNewDraftStartFromOrigin } from "../lib/chatThreadActions";
import { readT3ProjectFileDefaultThreadEnvMode } from "../lib/t3ProjectFileDefaults";
import { primaryServerSettingsAtom } from "../state/server";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import { useClientSettings } from "./useSettings";

interface NewThreadWorkspaceOptions {
  branch?: string | null;
  worktreePath?: string | null;
  envMode?: DraftThreadEnvMode;
  startFromOrigin?: boolean;
}

function resolveSelectableNewThreadSelection(
  selection: ModelSelection | null | undefined,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | null {
  if (!selection) return null;
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  if (
    !provider?.enabled ||
    !provider.installed ||
    provider.availability === "unavailable" ||
    provider.auth.status === "unauthenticated" ||
    !provider.models.some((model) => model.slug === selection.model && model.isLegacy !== true)
  ) {
    return null;
  }
  return createModelSelection(selection.instanceId, selection.model);
}

function resolveAdapterDefaultSelection(
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | null {
  for (const provider of providers) {
    if (
      !provider.enabled ||
      !provider.installed ||
      provider.availability === "unavailable" ||
      provider.auth.status === "unauthenticated"
    ) {
      continue;
    }
    const model =
      provider.models.find((candidate) => candidate.isDefault && candidate.isLegacy !== true) ??
      provider.models.find((candidate) => candidate.isLegacy !== true);
    if (model) return createModelSelection(provider.instanceId, model.slug);
  }
  return null;
}

export function resolveNewThreadConfiguredState(input: {
  configuredModel: ModelSelection | null | undefined;
  carryModel: ModelSelection | null | undefined;
  stickyActiveProvider: ModelSelection | null | undefined;
  providers: ReadonlyArray<ServerProvider>;
  settings: Pick<ServerSettings, "providerNewThreadDefaults">;
}) {
  const modelSelection =
    resolveSelectableNewThreadSelection(input.configuredModel, input.providers) ??
    resolveSelectableNewThreadSelection(input.carryModel, input.providers) ??
    resolveSelectableNewThreadSelection(input.stickyActiveProvider, input.providers) ??
    resolveAdapterDefaultSelection(input.providers);
  if (!modelSelection) {
    return { modelSelection: null, runtimeMode: DEFAULT_RUNTIME_MODE };
  }
  const provider = input.providers.find(
    (candidate) => candidate.instanceId === modelSelection.instanceId,
  );
  const model = provider?.models.find((candidate) => candidate.slug === modelSelection.model);
  const options = resolveConfiguredProviderOptionDefaults({
    settings: input.settings,
    instanceId: modelSelection.instanceId,
    descriptors: model?.capabilities?.optionDescriptors ?? [],
  });
  return {
    modelSelection: createModelSelection(modelSelection.instanceId, modelSelection.model, options),
    // Permission mode is provider-bound: the provider's configured default,
    // else the app default. It never carries over from the viewed thread.
    runtimeMode:
      resolveConfiguredRuntimeMode(input.settings, modelSelection.instanceId) ??
      DEFAULT_RUNTIME_MODE,
  };
}

// The workspace options the caller passed explicitly, shaped for the draft
// store: absent keys stay absent so they never overwrite existing draft
// state. Every reuse path applies exactly this set.
function pickExplicitWorkspaceOptions(options: NewThreadWorkspaceOptions | undefined) {
  return {
    ...(options?.branch !== undefined ? { branch: options.branch } : {}),
    ...(options?.worktreePath !== undefined ? { worktreePath: options.worktreePath } : {}),
    ...(options?.envMode !== undefined ? { envMode: options.envMode } : {}),
    ...(options?.startFromOrigin !== undefined ? { startFromOrigin: options.startFromOrigin } : {}),
  };
}

export function useNewThreadHandler() {
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  // New-thread defaults are a user preference, and the settings UI only ever
  // edits the primary environment's settings.json. Reading the target
  // environment's own settings here would silently reset remote projects to
  // the decoded defaults ("local" mode, current branch), since nothing can
  // set those values on a remote server.
  const primaryServerSettings = useAtomValue(primaryServerSettingsAtom);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const router = useRouter();
  const getCurrentRouteTarget = useCallback(() => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteTarget(currentRouteParams);
  }, [router]);

  return useCallback(
    (
      projectRef: ScopedProjectRef,
      options?: {
        branch?: string | null;
        worktreePath?: string | null;
        envMode?: DraftThreadEnvMode;
        startFromOrigin?: boolean;
        replace?: boolean;
        /**
         * Move the viewed draft's typed content (prompt + images) into the
         * draft this request lands on. Set by the draft repo picker: the
         * user started writing in the wrong project and the text should
         * follow them. Explicit new-thread surfaces leave this unset and
         * keep mint-fresh semantics.
         */
        carryComposerContent?: boolean;
      },
      // Which draft the thread ended up in, so a caller that has something to put in it — a
      // prepared checkout, a task to write — addresses that one rather than looking the project
      // up again and finding whichever draft it happens to hold.
    ): Promise<{ draftId: DraftId; threadId: ThreadId } | null> => {
      const {
        getComposerDraft,
        getDraftSessionByLogicalProjectKey,
        getDraftSession,
        getDraftThread,
        applyStickyState,
        moveComposerPromptAndImages,
        setDraftThreadContext,
        setLogicalProjectDraftThreadId,
        setModelSelection,
        setRuntimeMode,
        stickyActiveProvider,
        stickyModelSelectionByProvider,
      } = useComposerDraftStore.getState();
      const currentRouteTarget = getCurrentRouteTarget();
      // A new thread can carry the viewed provider/model and interaction
      // mode. Model options and permission mode come from the selected
      // provider's configured new-thread defaults instead. Branch, worktree,
      // and env mode never carry implicitly — those come from the configured
      // defaults unless the caller passes them explicitly.
      const carrySourceShell =
        currentRouteTarget?.kind === "server"
          ? readThreadShell(currentRouteTarget.threadRef)
          : null;
      const carrySourceDraft =
        currentRouteTarget?.kind === "draft" ? getDraftSession(currentRouteTarget.draftId) : null;
      // Composer overrides win over the persisted thread state — they are
      // what the user currently sees in the composer controls.
      const carrySourceComposer = currentRouteTarget
        ? getComposerDraft(
            currentRouteTarget.kind === "server"
              ? currentRouteTarget.threadRef
              : currentRouteTarget.draftId,
          )
        : null;
      const composerActiveProvider = carrySourceComposer?.activeProvider ?? null;
      const composerModelSelection = composerActiveProvider
        ? (carrySourceComposer?.modelSelectionByProvider[composerActiveProvider] ?? null)
        : null;
      const carryModelSelection =
        composerModelSelection ?? carrySourceShell?.modelSelection ?? null;
      const carryInteractionMode =
        carrySourceComposer?.interactionMode ??
        carrySourceShell?.interactionMode ??
        carrySourceDraft?.interactionMode ??
        null;
      // Content only moves when the caller opted in and the user is looking
      // at a draft. The content check happens at move time, not here: the
      // paths below await, and text typed during those awaits must still
      // come along.
      const carryContentSourceDraftId =
        options?.carryComposerContent === true && currentRouteTarget?.kind === "draft"
          ? currentRouteTarget.draftId
          : null;
      const carryComposerContentTo = (destinationDraftId: DraftId) => {
        if (
          carryContentSourceDraftId &&
          carryContentSourceDraftId !== destinationDraftId &&
          // Never clobber a destination the user already invested in — the
          // move overwrites the destination prompt, so a concurrent repo
          // change that carried content first must win.
          !composerDraftHasUserContent(getComposerDraft(destinationDraftId)) &&
          composerDraftHasUserContent(getComposerDraft(carryContentSourceDraftId))
        ) {
          moveComposerPromptAndImages(carryContentSourceDraftId, destinationDraftId);
        }
      };
      const project = projects.find(
        (candidate) =>
          candidate.id === projectRef.projectId &&
          candidate.environmentId === projectRef.environmentId,
      );
      const targetServerConfig = serverConfigs.get(projectRef.environmentId);
      const targetProviders = targetServerConfig?.providers ?? [];
      const targetSettings = targetServerConfig?.settings ?? primaryServerSettings;
      const stickyModelSelection = stickyActiveProvider
        ? stickyModelSelectionByProvider[stickyActiveProvider]
        : null;
      const newThreadState = resolveNewThreadConfiguredState({
        configuredModel: targetSettings.newThreadModel,
        carryModel: carryModelSelection,
        stickyActiveProvider: stickyModelSelection,
        providers: targetProviders,
        settings: targetSettings,
      });
      // The shared resolver owns the priority order. The t3.json read is
      // skipped entirely when a higher-priority source decides, and its
      // query atom caches per project after the first call.
      const resolveDefaultEnvMode = async (): Promise<DraftThreadEnvMode> => {
        const consultProjectFile = project !== undefined && project.defaultThreadEnvMode == null;
        return resolveDefaultThreadEnvMode({
          projectSetting: project?.defaultThreadEnvMode,
          projectFile: consultProjectFile
            ? await readT3ProjectFileDefaultThreadEnvMode(
                project.environmentId,
                project.workspaceRoot,
              )
            : null,
          globalDefault: primaryServerSettings.defaultThreadEnvMode,
        });
      };
      const logicalProjectKey = project
        ? deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings)
        : scopedProjectKey(projectRef);
      const hasBranchOption = options?.branch !== undefined;
      const hasWorktreePathOption = options?.worktreePath !== undefined;
      const hasEnvModeOption = options?.envMode !== undefined;
      const hasStartFromOriginOption = options?.startFromOrigin !== undefined;
      const storedDraftThread = getDraftSessionByLogicalProjectKey(logicalProjectKey);
      const storedDraftThreadRef = storedDraftThread
        ? scopeThreadRef(storedDraftThread.environmentId, storedDraftThread.threadId)
        : null;
      const reusableStoredDraftThread =
        storedDraftThreadRef && readThreadShell(storedDraftThreadRef) !== null
          ? null
          : storedDraftThread;
      if (storedDraftThreadRef && reusableStoredDraftThread === null) {
        markPromotedDraftThreadByRef(storedDraftThreadRef);
      }
      // New-thread surfaces (button, hotkeys, "/" landing, palette) only
      // ever reuse a draft the user has NOT invested in. A draft with typed
      // text or attachments is work in progress: it stays alive where it is
      // (reachable from the sidebar draft rows) and this request mints a
      // fresh draft instead — the remap in the store preserves invested
      // drafts rather than deleting them.
      const emptyStoredDraftThread =
        reusableStoredDraftThread &&
        !composerDraftHasUserContent(getComposerDraft(reusableStoredDraftThread.draftId))
          ? reusableStoredDraftThread
          : null;
      const latestActiveDraftThread: DraftThreadState | null = currentRouteTarget
        ? currentRouteTarget.kind === "server"
          ? getDraftThread(currentRouteTarget.threadRef)
          : getDraftSession(currentRouteTarget.draftId)
        : null;
      if (emptyStoredDraftThread) {
        return (async () => {
          const isDraftAlreadyOpen =
            currentRouteTarget?.kind === "draft" &&
            currentRouteTarget.draftId === emptyStoredDraftThread.draftId;
          const hasExplicitWorkspaceOption =
            hasBranchOption ||
            hasWorktreePathOption ||
            hasEnvModeOption ||
            hasStartFromOriginOption;
          // Resurrecting an empty stored draft must not resurrect its stale
          // context: explicit workspace options win outright; otherwise the
          // env context resets to the configured defaults so drafts seeded
          // before a defaults change (or by the old carry-over behavior) stop
          // landing on "current checkout" branches forever. When the draft is
          // already open and no options were passed, leave it alone entirely —
          // the user may have just picked a branch in the composer.
          let workspaceContext: NewThreadWorkspaceOptions | null = null;
          if (hasExplicitWorkspaceOption) {
            workspaceContext = pickExplicitWorkspaceOptions(options);
          } else if (!isDraftAlreadyOpen) {
            const defaultEnvMode = await resolveDefaultEnvMode();
            // The await yields. If the draft was opened (a concurrent
            // invocation's navigation landed), promoted to a real thread,
            // remapped away (a concurrent invocation registered a fresh
            // draft — remapping back would evict the winner and let the
            // store GC it), or gained content (no longer a reusable empty
            // draft) in the meantime, this invocation is a stale loser:
            // resetting context, remapping, or navigating would all clobber
            // state written after the snapshot above. Bail out entirely —
            // the winner already did this work.
            const routeTargetNow = getCurrentRouteTarget();
            const openedMeanwhile =
              routeTargetNow?.kind === "draft" &&
              routeTargetNow.draftId === emptyStoredDraftThread.draftId;
            const promotedMeanwhile =
              storedDraftThreadRef !== null && readThreadShell(storedDraftThreadRef) !== null;
            const remappedMeanwhile =
              getDraftSessionByLogicalProjectKey(logicalProjectKey)?.draftId !==
              emptyStoredDraftThread.draftId;
            const investedMeanwhile = composerDraftHasUserContent(
              getComposerDraft(emptyStoredDraftThread.draftId),
            );
            if (openedMeanwhile || promotedMeanwhile || remappedMeanwhile || investedMeanwhile) {
              return null;
            }
            workspaceContext = {
              branch: null,
              worktreePath: null,
              envMode: defaultEnvMode,
              startFromOrigin: resolveNewDraftStartFromOrigin({
                envMode: defaultEnvMode,
                newWorktreesStartFromOrigin: primaryServerSettings.newWorktreesStartFromOrigin,
              }),
            };
          }
          if (workspaceContext) {
            setDraftThreadContext(emptyStoredDraftThread.draftId, {
              ...workspaceContext,
              runtimeMode: newThreadState.runtimeMode,
              ...(carryInteractionMode ? { interactionMode: carryInteractionMode } : {}),
            });
          }
          // "New thread" always means current defaults for model, traits, and
          // permission mode, even when the reused draft is already open and
          // its workspace context is left alone above.
          if (newThreadState.modelSelection) {
            setModelSelection(emptyStoredDraftThread.draftId, newThreadState.modelSelection, {
              replaceOptions: true,
            });
          }
          setRuntimeMode(emptyStoredDraftThread.draftId, newThreadState.runtimeMode);
          // The workspace context must also ride along here: when projectRef
          // targets a different physical member of the logical project,
          // createDraftThreadState treats the remap as a project change and
          // would otherwise wipe branch/worktree, undoing the write above.
          setLogicalProjectDraftThreadId(
            logicalProjectKey,
            projectRef,
            emptyStoredDraftThread.draftId,
            {
              threadId: emptyStoredDraftThread.threadId,
              ...workspaceContext,
              runtimeMode: newThreadState.runtimeMode,
              ...(carryInteractionMode ? { interactionMode: carryInteractionMode } : {}),
            },
          );
          carryComposerContentTo(emptyStoredDraftThread.draftId);
          const opened = {
            draftId: emptyStoredDraftThread.draftId,
            threadId: emptyStoredDraftThread.threadId,
          };
          // Re-read the route: the snapshot from before the await is stale
          // once a concurrent invocation's navigation lands, and navigating
          // again would push a duplicate history entry.
          const routeTargetAfterWrites = getCurrentRouteTarget();
          if (
            routeTargetAfterWrites?.kind === "draft" &&
            routeTargetAfterWrites.draftId === emptyStoredDraftThread.draftId
          ) {
            return opened;
          }
          await router.navigate({
            to: "/draft/$draftId",
            params: { draftId: emptyStoredDraftThread.draftId },
            replace: options?.replace ?? false,
          });
          return opened;
        })();
      }

      if (
        latestActiveDraftThread &&
        currentRouteTarget?.kind === "draft" &&
        latestActiveDraftThread.logicalProjectKey === logicalProjectKey &&
        latestActiveDraftThread.promotedTo == null &&
        // Same content rule as above: a new-thread request while viewing an
        // invested draft mints a fresh one instead of repurposing it.
        !composerDraftHasUserContent(getComposerDraft(currentRouteTarget.draftId))
      ) {
        if (
          hasBranchOption ||
          hasWorktreePathOption ||
          hasEnvModeOption ||
          hasStartFromOriginOption
        ) {
          setDraftThreadContext(currentRouteTarget.draftId, pickExplicitWorkspaceOptions(options));
        }
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, currentRouteTarget.draftId, {
          threadId: latestActiveDraftThread.threadId,
          createdAt: latestActiveDraftThread.createdAt,
          runtimeMode: latestActiveDraftThread.runtimeMode,
          interactionMode: latestActiveDraftThread.interactionMode,
          ...pickExplicitWorkspaceOptions(options),
        });
        return Promise.resolve({
          draftId: currentRouteTarget.draftId,
          threadId: latestActiveDraftThread.threadId,
        });
      }

      const draftId = newDraftId();
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      return (async () => {
        const initialEnvMode = options?.envMode ?? (await resolveDefaultEnvMode());
        // The await yields, so a concurrent invocation may have registered a
        // draft for this logical project in the meantime. Registering ours
        // too would evict that draft while its navigation is in flight —
        // reuse the winner instead, like the synchronous path above does.
        const racedDraft = getDraftSessionByLogicalProjectKey(logicalProjectKey);
        if (
          racedDraft &&
          // Only a draft REGISTERED during the await counts as a raced
          // winner. An invested draft this invocation deliberately declined
          // to reuse is still mapped at this point — reusing it here would
          // silently undo mint-fresh semantics.
          racedDraft.draftId !== storedDraftThread?.draftId &&
          readThreadShell(scopeThreadRef(racedDraft.environmentId, racedDraft.threadId)) === null
        ) {
          // Same remap the reuse paths above perform: point the draft at the
          // caller's project member and apply explicit workspace options if
          // the caller passed any. Without explicit options the winner's
          // context stands untouched — the winner's navigation is landing,
          // which is the isDraftAlreadyOpen "leave it alone" case. Writing
          // this invocation's defaults here instead would clobber the
          // winner's explicit picks and could pair its worktreePath with a
          // contradictory envMode.
          setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, racedDraft.draftId, {
            threadId: racedDraft.threadId,
            createdAt: racedDraft.createdAt,
            runtimeMode: racedDraft.runtimeMode,
            interactionMode: racedDraft.interactionMode,
            ...pickExplicitWorkspaceOptions(options),
          });
          carryComposerContentTo(racedDraft.draftId);
          await router.navigate({
            to: "/draft/$draftId",
            params: { draftId: racedDraft.draftId },
            replace: options?.replace ?? false,
          });
          return { draftId: racedDraft.draftId, threadId: racedDraft.threadId };
        }
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
          threadId,
          createdAt,
          branch: options?.branch ?? null,
          worktreePath: options?.worktreePath ?? null,
          envMode: initialEnvMode,
          startFromOrigin:
            options?.startFromOrigin ??
            resolveNewDraftStartFromOrigin({
              envMode: initialEnvMode,
              newWorktreesStartFromOrigin: primaryServerSettings.newWorktreesStartFromOrigin,
            }),
          runtimeMode: newThreadState.runtimeMode,
          ...(carryInteractionMode ? { interactionMode: carryInteractionMode } : {}),
        });
        applyStickyState(draftId);
        if (newThreadState.modelSelection) {
          setModelSelection(draftId, newThreadState.modelSelection, { replaceOptions: true });
        }
        carryComposerContentTo(draftId);

        await router.navigate({
          to: "/draft/$draftId",
          params: { draftId },
          replace: options?.replace ?? false,
        });
        return { draftId, threadId };
      })();
    },
    [
      getCurrentRouteTarget,
      primaryServerSettings,
      projectGroupingSettings,
      projects,
      router,
      serverConfigs,
    ],
  );
}

export function useHandleNewThread() {
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const activeThread = useThread(routeThreadRef);
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const activeDraftThread = useComposerDraftStore(() =>
    routeTarget
      ? routeTarget.kind === "server"
        ? getDraftThread(routeTarget.threadRef)
        : useComposerDraftStore.getState().getDraftSession(routeTarget.draftId)
      : null,
  );
  const projects = useProjects();
  const orderedProjects = useMemo(() => {
    return orderItemsByPreferredIds({
      items: projects,
      preferredIds: projectOrder,
      getId: getProjectOrderKey,
      getPreferenceIds: (project) => [
        getProjectOrderKey(project),
        legacyProjectCwdPreferenceKey(project.workspaceRoot),
      ],
    });
  }, [projectOrder, projects]);
  const handleNewThread = useNewThreadHandler();

  return {
    activeDraftThread,
    activeThread,
    defaultProjectRef: orderedProjects[0]
      ? scopeProjectRef(orderedProjects[0].environmentId, orderedProjects[0].id)
      : null,
    handleNewThread,
    routeThreadRef,
  };
}
