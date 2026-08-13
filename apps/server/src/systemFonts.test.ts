import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ProcessRunner, type ProcessRunInput } from "./processRunner.ts";
import {
  enumerateHostFontFamilies,
  parseFontconfigFamilies,
  parseFontconfigMatchFile,
  parseMacFontFile,
  parseMacFontFamilies,
  parseWindowsFontFamilies,
  readHostFontFamily,
} from "./systemFonts.ts";

describe("host font enumeration", () => {
  it("normalizes fontconfig families and aliases", () => {
    expect(parseFontconfigFamilies("Jost*,Jost* Black\nInter\nJost*\n")).toEqual([
      "Inter",
      "Jost*",
      "Jost* Black",
    ]);
  });

  it("parses platform JSON output", () => {
    expect(parseWindowsFontFamilies('["Inter","Jost*","Inter"]')).toEqual(["Inter", "Jost*"]);
    expect(
      parseMacFontFamilies(
        JSON.stringify({ SPFontsDataType: [{ family: "Jost*" }, { familyName: "Inter" }] }),
      ),
    ).toEqual(["Inter", "Jost*"]);
  });

  it("resolves exact font files without accepting a fontconfig fallback", () => {
    expect(parseFontconfigMatchFile("Jost*\u001f/fonts/Jost.ttf", "Jost*")).toBe("/fonts/Jost.ttf");
    expect(parseFontconfigMatchFile("Noto Sans\u001f/fonts/Noto.ttf", "Missing Font")).toBeNull();
    expect(
      parseMacFontFile(
        JSON.stringify({
          SPFontsDataType: [{ family: "Jost*", path: "/Library/Fonts/Jost.ttf" }],
        }),
        "Jost*",
      ),
    ).toBe("/Library/Fonts/Jost.ttf");
  });

  it.effect("queries fontconfig on every invocation", () => {
    let calls = 0;
    let lastInput: ProcessRunInput | null = null;
    const runner = ProcessRunner.of({
      run: (input) => {
        calls += 1;
        lastInput = input;
        return Effect.succeed({
          code: ChildProcessSpawner.ExitCode(0),
          stdout: calls === 1 ? "Inter\n" : "Inter\nJost*\n",
          stderr: "",
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        });
      },
    });

    return Effect.gen(function* () {
      expect(yield* enumerateHostFontFamilies()).toEqual({
        families: ["Inter"],
        status: "available",
      });
      expect(yield* enumerateHostFontFamilies()).toEqual({
        families: ["Inter", "Jost*"],
        status: "available",
      });
      expect(lastInput).toMatchObject({
        command: "fc-list",
        args: ["--format=%{family}\\n"],
      });
    }).pipe(
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provideService(ProcessRunner, runner),
    );
  });

  it.effect("reads the exact fontconfig match as binary data", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-font-test-" });
      const fontPath = path.join(directory, "Jost.ttf");
      yield* fileSystem.writeFile(fontPath, Uint8Array.from([1, 2, 3, 4]));
      const runner = ProcessRunner.of({
        run: () =>
          Effect.succeed({
            code: ChildProcessSpawner.ExitCode(0),
            stdout: `Jost*\u001f${fontPath}`,
            stderr: "",
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          }),
      });

      const bytes = yield* readHostFontFamily("Jost*").pipe(
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(ProcessRunner, runner),
      );
      expect(bytes === null ? null : [...bytes]).toEqual([1, 2, 3, 4]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
