import { PrimaryEnvironmentHttpClient } from "./environments/primary/httpClient";
import { runPrimaryHttp } from "./lib/runtime";
import * as Effect from "effect/Effect";
import { cssFontFamilies } from "./appearanceFonts";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);

export function canUseHostFontEnumeration(): boolean {
  if (typeof window === "undefined") return false;
  if (window.desktopBridge !== undefined) return true;
  const hostname = window.location.hostname.toLowerCase();
  return LOOPBACK_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost");
}

/**
 * Chromium snapshots its Local Font Access result for the life of the browser
 * process. A local T3 server can enumerate the same host live after that
 * snapshot goes stale. Never use this for remote web clients: their fonts live
 * on the viewing device, not the environment server.
 */
export async function queryHostFontFamilies(): Promise<readonly string[] | null> {
  if (!canUseHostFontEnumeration()) return null;
  try {
    const result = await runPrimaryHttp(
      PrimaryEnvironmentHttpClient.pipe(
        Effect.flatMap((client) => client.system.fonts({ headers: {} })),
      ),
    );
    return result.status === "available" ? result.families : null;
  } catch {
    return null;
  }
}

const hostFontLoads = new Map<string, Promise<boolean>>();

/** Register a host font as a document font, bypassing Chromium's stale OS cache. */
export function loadHostFontFamily(family: string): Promise<boolean> {
  const normalized = family.trim();
  const cssFamily = cssFontFamilies(normalized);
  if (
    cssFamily === null ||
    !canUseHostFontEnumeration() ||
    typeof FontFace === "undefined" ||
    typeof document === "undefined"
  ) {
    return Promise.resolve(false);
  }
  const cached = hostFontLoads.get(normalized);
  if (cached !== undefined) return cached;

  const load = (async () => {
    try {
      const bytes = await runPrimaryHttp(
        PrimaryEnvironmentHttpClient.pipe(
          Effect.flatMap((client) =>
            client.system.fontFile({ headers: {}, payload: { family: normalized } }),
          ),
        ),
      );
      const face = new FontFace(cssFamily, Uint8Array.from(bytes));
      document.fonts.add(face);
      await face.load();
      return true;
    } catch {
      hostFontLoads.delete(normalized);
      return false;
    }
  })();
  hostFontLoads.set(normalized, load);
  return load;
}
