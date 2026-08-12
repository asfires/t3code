import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef } from "react";

import { INITIAL_SERVER_BOOT_RELOAD_STATE, observeServerBoot } from "../serverBootReload";
import { primaryServerReadyAtom } from "../state/server";

export function ServerBootReload() {
  const bootIdentity = useAtomValue(primaryServerReadyAtom)?.at ?? null;
  const stateRef = useRef(INITIAL_SERVER_BOOT_RELOAD_STATE);

  useEffect(() => {
    if (bootIdentity === null) return;

    const transition = observeServerBoot(stateRef.current, bootIdentity);
    stateRef.current = transition.state;
    if (transition.shouldReload) window.location.reload();
  }, [bootIdentity]);

  return null;
}
