import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentCatalogState } from "@t3tools/client-runtime/state/connections";
import { EnvironmentId, type ServerLifecycleReadyPayload } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { environmentCatalog } from "../connection/catalog";
import { INITIAL_SERVER_BOOT_RELOAD_STATE, observeServerBoot } from "../serverBootReload";
import { primaryServerReadyAtom, serverEnvironment } from "./server";

const PRIMARY = EnvironmentId.make("primary");
const REMOTE = EnvironmentId.make("remote");

function readPrimaryReady(primaryBoot: string | null, remoteBoot: string) {
  const catalog: EnvironmentCatalogState = {
    isReady: true,
    entries: new Map([
      [
        REMOTE,
        {
          target: new BearerConnectionTarget({
            environmentId: REMOTE,
            connectionId: "remote",
            label: "Remote",
          }),
          profile: Option.none(),
          enabled: true,
        },
      ],
    ]),
  };
  const entries = new Map(catalog.entries);
  if (primaryBoot !== null) {
    entries.set(PRIMARY, {
      target: new PrimaryConnectionTarget({
        environmentId: PRIMARY,
        label: "Primary",
        httpBaseUrl: "https://primary.example.test",
        wsBaseUrl: "wss://primary.example.test",
      }),
      profile: Option.none(),
      enabled: true,
    });
  }
  const primaryTarget = { environmentId: PRIMARY, input: {} };
  const ready = (at: string): ServerLifecycleReadyPayload => ({
    at,
    environment: {} as ServerLifecycleReadyPayload["environment"],
  });
  const registry = AtomRegistry.make({
    initialValues: [
      [environmentCatalog.catalogValueAtom, { ...catalog, entries }],
      [serverEnvironment.configProjection(primaryTarget), AsyncResult.initial()],
      [serverEnvironment.configValueAtom(PRIMARY), null],
      [serverEnvironment.welcome(primaryTarget), AsyncResult.initial()],
      [
        serverEnvironment.ready(primaryTarget),
        primaryBoot === null ? AsyncResult.initial() : AsyncResult.success(ready(primaryBoot)),
      ],
      [
        serverEnvironment.ready({ environmentId: REMOTE, input: {} }),
        AsyncResult.success(ready(remoteBoot)),
      ],
    ],
  });
  try {
    return registry.get(primaryServerReadyAtom);
  } finally {
    registry.dispose();
  }
}

describe("primary server boot", () => {
  it("ignores remote restarts in a hosted app with no primary connection", () => {
    expect(readPrimaryReady(null, "remote-a")).toBeNull();
    expect(readPrimaryReady(null, "remote-b")).toBeNull();
  });

  it("reloads only when the server serving the bundle restarts", () => {
    let state = INITIAL_SERVER_BOOT_RELOAD_STATE;
    const reloads = [
      readPrimaryReady("primary-a", "remote-a"),
      readPrimaryReady("primary-a", "remote-b"),
      readPrimaryReady("primary-b", "remote-b"),
      readPrimaryReady("primary-b", "remote-c"),
    ].map((ready) => {
      const transition = observeServerBoot(state, ready!.at);
      state = transition.state;
      return transition.shouldReload;
    });
    expect(reloads).toEqual([false, false, true, false]);
  });
});
