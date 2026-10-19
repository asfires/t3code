import { AuthOrchestrationReadScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as SystemFonts from "./SystemFonts.ts";

export const layer = HttpApiBuilder.group(EnvironmentHttpApi, "system", (handlers) =>
  Effect.gen(function* () {
    const fonts = yield* SystemFonts.SystemFonts;
    return handlers
      .handle(
        "fonts",
        Effect.fn("environment.system.fonts")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* fonts.enumerate();
        }),
      )
      .handle(
        "fontFile",
        Effect.fn("environment.system.fontFile")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const bytes = yield* fonts.readFamily(args.query.family);
          if (bytes === null) return yield* failEnvironmentNotFound("font_not_found");
          return bytes;
        }),
      );
  }),
);
