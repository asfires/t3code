import { AuthOrchestrationReadScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "./auth/http.ts";
import * as ProcessRunner from "./processRunner.ts";
import { enumerateHostFontFamilies, readHostFontFamily } from "./systemFonts.ts";

export const systemFontsHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "system",
  (handlers) =>
    Effect.gen(function* () {
      const processRunner = yield* ProcessRunner.ProcessRunner;
      const fileSystem = yield* FileSystem.FileSystem;
      return handlers
        .handle(
          "fonts",
          Effect.fn("environment.system.fonts")(function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthOrchestrationReadScope);
            return yield* enumerateHostFontFamilies().pipe(
              Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
            );
          }),
        )
        .handle(
          "fontFile",
          Effect.fn("environment.system.fontFile")(function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthOrchestrationReadScope);
            const bytes = yield* readHostFontFamily(args.payload.family).pipe(
              Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
              Effect.provideService(FileSystem.FileSystem, fileSystem),
            );
            if (bytes === null) return yield* failEnvironmentNotFound("font_not_found");
            return bytes;
          }),
        );
    }),
).pipe(Layer.provide(ProcessRunner.layer));
