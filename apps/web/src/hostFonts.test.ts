import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("./lib/runtime", () => ({ runPrimaryHttp: vi.fn() }));

import { runPrimaryHttp } from "./lib/runtime";
import { canUseHostFontEnumeration, loadHostFontFamily, queryHostFontFamilies } from "./hostFonts";

beforeEach(() => {
  vi.mocked(runPrimaryHttp).mockReset();
});

afterEach(() => vi.unstubAllGlobals());

describe("host font access", () => {
  it.each(["localhost", "127.0.0.1", "[::1]", "font-picker.localhost"])(
    "uses host fonts at %s",
    (hostname) => {
      vi.stubGlobal("window", { location: new URL(`http://${hostname}:5173`) });
      expect(canUseHostFontEnumeration()).toBe(true);
    },
  );

  it("uses the desktop host and excludes remote web clients", async () => {
    vi.stubGlobal("window", { location: new URL("https://app.t3.codes") });
    expect(canUseHostFontEnumeration()).toBe(false);
    expect(await queryHostFontFamilies()).toBeNull();
    expect(runPrimaryHttp).not.toHaveBeenCalled();
    vi.stubGlobal("window", { desktopBridge: {} });
    expect(canUseHostFontEnumeration()).toBe(true);
  });

  it("queries fresh families and falls back when host discovery fails", async () => {
    vi.stubGlobal("window", { location: new URL("http://localhost") });
    vi.mocked(runPrimaryHttp)
      .mockResolvedValueOnce({ status: "available", families: ["Inter"] })
      .mockResolvedValueOnce({ status: "available", families: ["Inter", "New Font"] })
      .mockResolvedValueOnce({ status: "unsupported", families: [] })
      .mockRejectedValueOnce(new Error("Disconnected"));
    expect(await queryHostFontFamilies()).toEqual(["Inter"]);
    expect(await queryHostFontFamilies()).toEqual(["Inter", "New Font"]);
    expect(await queryHostFontFamilies()).toBeNull();
    expect(await queryHostFontFamilies()).toBeNull();
  });

  it("registers binary font data once and retries failed downloads", async () => {
    vi.stubGlobal("window", { location: new URL("http://localhost") });
    const add = vi.fn();
    const load = vi.fn(async () => undefined);
    const faces: Array<{ family: string; bytes: Uint8Array }> = [];
    vi.stubGlobal("document", { fonts: { add } });
    vi.stubGlobal(
      "FontFace",
      class {
        load = load;
        constructor(family: string, bytes: Uint8Array) {
          faces.push({ family, bytes });
        }
      },
    );
    vi.mocked(runPrimaryHttp)
      .mockRejectedValueOnce(new Error("Disconnected"))
      .mockResolvedValueOnce(Uint8Array.from([1, 2, 3]));
    expect(await loadHostFontFamily("New Font")).toBe(false);
    expect(await loadHostFontFamily("New Font")).toBe(true);
    expect(await loadHostFontFamily(" New Font ")).toBe(true);
    expect(runPrimaryHttp).toHaveBeenCalledTimes(2);
    expect(faces).toEqual([{ family: '"New Font"', bytes: Uint8Array.from([1, 2, 3]) }]);
    expect(add).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
  });
});
