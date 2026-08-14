import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { ProcessRunner } from "./processRunner.ts";

export interface HostFontEnumerationResult {
  readonly families: readonly string[];
  readonly status: "available" | "unsupported";
}

class HostFontOutputParseError extends Data.TaggedError("HostFontOutputParseError")<{
  readonly cause: unknown;
}> {}

const MAX_FONT_FILE_BYTES = 32 * 1024 * 1024;

function sortedFamilies(families: Iterable<string>): readonly string[] {
  return [...new Set([...families].map((family) => family.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

export function parseFontconfigFamilies(output: string): readonly string[] {
  return sortedFamilies(output.split(/\r?\n/).flatMap((line) => line.split(",")));
}

export function parseWindowsFontFamilies(output: string): readonly string[] {
  const parsed: unknown = JSON.parse(output);
  if (typeof parsed === "string") return sortedFamilies([parsed]);
  if (!Array.isArray(parsed)) return [];
  return sortedFamilies(parsed.filter((family): family is string => typeof family === "string"));
}

export function parseMacFontFamilies(output: string): readonly string[] {
  const parsed: unknown = JSON.parse(output);
  const families: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if ((key === "family" || key === "familyName") && typeof child === "string") {
        families.push(child);
      }
      visit(child);
    }
  };
  visit(parsed);
  return sortedFamilies(families);
}

export function parseFontconfigMatchFile(output: string, family: string): string | null {
  const [familyOutput, fileOutput] = output.split("\u001f", 2);
  if (familyOutput === undefined || fileOutput === undefined) return null;
  const matchesFamily = familyOutput
    .split(",")
    .some(
      (candidate) =>
        candidate.trim().localeCompare(family, undefined, { sensitivity: "accent" }) === 0,
    );
  return matchesFamily && fileOutput.trim().length > 0 ? fileOutput.trim() : null;
}

export function parseMacFontFile(output: string, family: string): string | null {
  const parsed: unknown = JSON.parse(output);
  let match: string | null = null;
  const visit = (value: unknown): void => {
    if (match !== null) return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const candidate = record.family ?? record.familyName;
    if (
      typeof candidate === "string" &&
      candidate.localeCompare(family, undefined, { sensitivity: "accent" }) === 0 &&
      typeof record.path === "string"
    ) {
      match = record.path;
      return;
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(parsed);
  return match;
}

const WINDOWS_FONT_COMMAND =
  "[System.Reflection.Assembly]::LoadWithPartialName('System.Drawing') | Out-Null; " +
  "(New-Object System.Drawing.Text.InstalledFontCollection).Families.Name | ConvertTo-Json -Compress";

const WINDOWS_FONT_FILE_COMMAND = `
$family = [Console]::In.ReadToEnd()
$roots = @(
  'HKCU:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
  'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'
)
$matches = foreach ($root in $roots) {
  if (-not (Test-Path $root)) { continue }
  $key = Get-Item $root
  foreach ($name in $key.GetValueNames()) {
    if (-not $name.StartsWith($family, [StringComparison]::OrdinalIgnoreCase)) { continue }
    $value = $key.GetValue($name)
    if (-not [IO.Path]::IsPathRooted($value)) {
      $value = Join-Path $env:WINDIR (Join-Path 'Fonts' $value)
    }
    [PSCustomObject]@{ Name = $name; Path = $value }
  }
}
$match = $matches | Sort-Object { $_.Name.Length } | Select-Object -First 1
if ($null -ne $match) { [Console]::Out.Write($match.Path) }
`;

export const enumerateHostFontFamilies = Effect.fn("systemFonts.enumerateHostFontFamilies")(
  function* () {
    const platform = yield* HostProcessPlatform;
    const processRunner = yield* ProcessRunner;
    const command =
      platform === "linux"
        ? { executable: "fc-list", args: ["--format=%{family}\\n"], parse: parseFontconfigFamilies }
        : platform === "darwin"
          ? {
              executable: "/usr/sbin/system_profiler",
              args: ["SPFontsDataType", "-json", "-detailLevel", "mini"],
              parse: parseMacFontFamilies,
            }
          : platform === "win32"
            ? {
                executable: "powershell.exe",
                args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_FONT_COMMAND],
                parse: parseWindowsFontFamilies,
              }
            : null;
    if (command === null) return { families: [], status: "unsupported" } as const;

    return yield* processRunner
      .run({
        command: command.executable,
        args: command.args,
        timeout: "15 seconds",
        maxOutputBytes: 16 * 1024 * 1024,
      })
      .pipe(
        Effect.flatMap((result) => {
          if (result.code !== 0) {
            return Effect.succeed({ families: [], status: "unsupported" } as const);
          }
          return Effect.try({
            try: (): HostFontEnumerationResult => ({
              families: command.parse(result.stdout),
              status: "available",
            }),
            catch: (cause) => new HostFontOutputParseError({ cause }),
          });
        }),
        Effect.catch((cause) =>
          Effect.logWarning("Failed to enumerate host fonts", { cause }).pipe(
            Effect.as({ families: [], status: "unsupported" } as const),
          ),
        ),
      );
  },
);

/**
 * Read one exact host font face so a renderer with a stale system-font cache
 * can register it as a document font. The family is resolved by the OS; it is
 * never interpreted as a path supplied by the client.
 */
export const readHostFontFamily = Effect.fn("systemFonts.readHostFontFamily")(function* (
  family: string,
) {
  const platform = yield* HostProcessPlatform;
  const processRunner = yield* ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const command =
    platform === "linux"
      ? {
          executable: "fc-match",
          args: ["--format=%{family}\u001f%{file}", family],
          stdin: undefined,
          parse: (output: string) => parseFontconfigMatchFile(output, family),
        }
      : platform === "darwin"
        ? {
            executable: "/usr/sbin/system_profiler",
            args: ["SPFontsDataType", "-json", "-detailLevel", "mini"],
            stdin: undefined,
            parse: (output: string) => parseMacFontFile(output, family),
          }
        : platform === "win32"
          ? {
              executable: "powershell.exe",
              args: ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_FONT_FILE_COMMAND],
              stdin: family,
              parse: (output: string) => (output.trim().length > 0 ? output.trim() : null),
            }
          : null;
  if (command === null) return null;

  return yield* processRunner
    .run({
      command: command.executable,
      args: command.args,
      stdin: command.stdin,
      timeout: "15 seconds",
      maxOutputBytes: 16 * 1024 * 1024,
    })
    .pipe(
      Effect.flatMap((result) => {
        if (result.code !== 0) return Effect.succeed(null);
        return Effect.try({
          try: () => command.parse(result.stdout),
          catch: (cause) => new HostFontOutputParseError({ cause }),
        });
      }),
      Effect.flatMap((fontPath) => {
        if (fontPath === null || !/\.(otf|ttc|ttf|woff2?)$/i.test(fontPath)) {
          return Effect.succeed(null);
        }
        return fileSystem
          .stat(fontPath)
          .pipe(
            Effect.flatMap((stat) =>
              stat.type === "File" && stat.size <= MAX_FONT_FILE_BYTES
                ? fileSystem.readFile(fontPath)
                : Effect.succeed(null),
            ),
          );
      }),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to load host font family", { family, cause }).pipe(
          Effect.as(null),
        ),
      ),
    );
});
