import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useMemo } from "react";

import { useThreadShells, useThreadShellsForProjectRefs } from "../../state/entities";
import {
  type PendingRetractionRecovery,
  useRetractionRecoveryStore,
} from "./lastUserMessageRecovery";

export function filterDiscoverableThreadShells(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  recoveries: Readonly<Record<string, PendingRetractionRecovery>>,
): ReadonlyArray<EnvironmentThreadShell> {
  const hiddenThreadKeys = new Set(
    Object.values(recoveries).flatMap((recovery) =>
      recovery.firstUserMessage === true ? [scopedThreadKey(recovery.sourceThreadRef)] : [],
    ),
  );
  if (hiddenThreadKeys.size === 0) return threads;
  return threads.filter(
    (thread) =>
      !hiddenThreadKeys.has(
        scopedThreadKey({ environmentId: thread.environmentId, threadId: thread.id }),
      ),
  );
}

function useDiscoverableThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<EnvironmentThreadShell> {
  const recoveries = useRetractionRecoveryStore((state) => state.byRequestId);
  return useMemo(() => filterDiscoverableThreadShells(threads, recoveries), [recoveries, threads]);
}

export function useDiscoverableThreadShells(): ReadonlyArray<EnvironmentThreadShell> {
  return useDiscoverableThreads(useThreadShells());
}

export function useDiscoverableThreadShellsForProjectRefs(
  refs: ReadonlyArray<ScopedProjectRef>,
): ReadonlyArray<EnvironmentThreadShell> {
  return useDiscoverableThreads(useThreadShellsForProjectRefs(refs));
}
