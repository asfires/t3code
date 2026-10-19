import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentAuthInvalidError,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as SystemFonts from "./SystemFonts.ts";
import * as SystemFontsHttp from "./http.ts";

class FontsTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.system) {}

it.effect("serves font lists and binary files only to authenticated readers", () =>
  Effect.gen(function* () {
    let authenticated = true;
    let allowed = true;
    let calls = 0;
    const routes = HttpApiBuilder.layer(FontsTestApi).pipe(
      Layer.provide(SystemFontsHttp.layer),
      Layer.provide(
        Layer.succeed(SystemFonts.SystemFonts, {
          enumerate: () =>
            Effect.sync(() => {
              calls++;
              return { status: "available" as const, families: ["Jost*"] };
            }),
          readFamily: (family) =>
            Effect.sync(() => {
              calls++;
              return family === "Jost*" ? Uint8Array.from([0, 1, 2, 255]) : null;
            }),
        }),
      ),
      Layer.provide(
        Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
          Effect.gen(function* () {
            if (!authenticated) {
              return yield* new EnvironmentAuthInvalidError({
                code: "auth_invalid",
                reason: "missing_credential",
                traceId: "font-test",
              });
            }
            return yield* effect.pipe(
              Effect.provideService(EnvironmentAuthenticatedPrincipal, {
                sessionId: AuthSessionId.make("font-test"),
                subject: "test",
                method: "bearer-access-token",
                scopes: new Set<AuthEnvironmentScope>(allowed ? ["orchestration:read"] : []),
              }),
            );
          }),
        ),
      ),
      Layer.provide(HttpPlatform.layer),
      Layer.provide(Etag.layerWeak),
      Layer.provide(NodeServices.layer),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
    yield* Effect.addFinalizer(() => Effect.promise(dispose));
    const get = (path: string) =>
      Effect.promise(() => handler(new Request(`http://localhost/api/system/${path}`)));

    const list = yield* get("fonts");
    expect(list.status).toBe(200);
    expect(yield* Effect.promise(() => list.json())).toEqual({
      status: "available",
      families: ["Jost*"],
    });
    const file = yield* get("font-file?family=Jost%2A");
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("application/octet-stream");
    expect(new Uint8Array(yield* Effect.promise(() => file.arrayBuffer()))).toEqual(
      Uint8Array.from([0, 1, 2, 255]),
    );
    expect((yield* get("font-file?family=Missing")).status).toBe(404);
    expect((yield* get("font-file")).status).toBe(400);

    const authorizedCalls = calls;
    allowed = false;
    expect((yield* get("fonts")).status).toBe(403);
    expect((yield* get("font-file?family=Jost%2A")).status).toBe(403);
    authenticated = false;
    expect((yield* get("fonts")).status).toBe(401);
    expect((yield* get("font-file?family=Jost%2A")).status).toBe(401);
    expect(calls).toBe(authorizedCalls);
  }),
);
