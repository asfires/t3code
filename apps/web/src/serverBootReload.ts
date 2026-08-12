export interface ServerBootReloadState {
  readonly initialBootIdentity: string | null;
  readonly reloadPending: boolean;
}

export interface ServerBootReloadTransition {
  readonly state: ServerBootReloadState;
  readonly shouldReload: boolean;
}

export const INITIAL_SERVER_BOOT_RELOAD_STATE: ServerBootReloadState = {
  initialBootIdentity: null,
  reloadPending: false,
};

export function observeServerBoot(
  state: ServerBootReloadState,
  bootIdentity: string,
): ServerBootReloadTransition {
  if (state.initialBootIdentity === null) {
    return {
      state: { initialBootIdentity: bootIdentity, reloadPending: false },
      shouldReload: false,
    };
  }
  if (state.reloadPending || state.initialBootIdentity === bootIdentity) {
    return { state, shouldReload: false };
  }
  return {
    state: { ...state, reloadPending: true },
    shouldReload: true,
  };
}
