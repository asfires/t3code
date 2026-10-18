import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const families = vi.hoisted(() => {
  const families = [
    "Arial",
    "Courier New",
    "Fira Code",
    "Georgia",
    "Helvetica",
    "JetBrains Mono",
    "Menlo",
    "Times New Roman",
  ];
  // The picker decides at module load whether the engine can list fonts.
  Object.assign(window, { queryLocalFonts: async () => families.map((family) => ({ family })) });
  return families;
});

vi.mock("../../appearanceFonts", () => ({
  isMonospaceFamily: () => true,
  isFontFamilyAvailable: (family: string) => family === "Custom Font",
  queryInstalledFontFamilies: vi.fn(async () => ({ status: "granted", families })),
}));

vi.mock("../../hostFonts", () => ({
  canUseHostFontEnumeration: () => false,
  queryHostFontFamilies: vi.fn(async (): Promise<readonly string[] | null> => null),
  loadHostFontFamily: vi.fn(async () => true),
}));

import { queryHostFontFamilies } from "../../hostFonts";
import { queryInstalledFontFamilies } from "../../appearanceFonts";
import { userEvent } from "vite-plus/test/browser";
import { discoverInstalledFonts, FontFamilyPicker } from "./FontFamilyPicker";

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(queryHostFontFamilies).mockResolvedValue(null);
  vi.mocked(queryInstalledFontFamilies).mockResolvedValue({ status: "granted", families });
  await act(async () => discoverInstalledFonts({ refresh: true }));
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function highlightedOptions(): string[] {
  return [...document.querySelectorAll('[role="option"][data-highlighted]')].map(
    (option) => option.textContent ?? "",
  );
}

async function typeQuery(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("FontFamilyPicker", () => {
  it("highlights, moves through, and selects matches after filtering", async () => {
    const onSelect = vi.fn();
    await act(async () =>
      root.render(
        <FontFamilyPicker
          ariaLabel="Code font"
          defaultFamily="Menlo"
          selectedFamily=""
          initialOpen
          onSelect={onSelect}
        />,
      ),
    );

    const input = document.querySelector<HTMLInputElement>(
      'input[placeholder="Search or enter a font…"]',
    );
    expect(input).not.toBeNull();
    const press = (key: string) =>
      act(async () => {
        input!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      });

    // Both matches were already rendered further down the unfiltered list.
    await typeQuery(input!, "co");
    await vi.waitFor(() => expect(highlightedOptions()).toEqual(["Courier New"]));

    await press("ArrowDown");
    await vi.waitFor(() => expect(highlightedOptions()).toEqual(["Fira Code"]));

    await press("Enter");
    expect(onSelect).toHaveBeenCalledWith("Fira Code");
  });
});

describe("font discovery in the picker", () => {
  it("refreshes host fonts on every open", async () => {
    vi.mocked(queryHostFontFamilies).mockResolvedValue(["Inter"]);
    await act(async () =>
      root.render(
        <FontFamilyPicker
          ariaLabel="Interface font"
          defaultFamily="Arial"
          selectedFamily=""
          onSelect={() => {}}
        />,
      ),
    );
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Interface font"]')!;
    await userEvent.click(trigger);
    await vi.waitFor(() =>
      expect(
        [...document.querySelectorAll('[role="option"]')].map((el) => el.textContent),
      ).toContain("Inter"),
    );
    await userEvent.keyboard("{Escape}");
    vi.mocked(queryHostFontFamilies).mockResolvedValue(["Inter", "Newly Installed"]);
    await userEvent.click(trigger);
    await vi.waitFor(() =>
      expect(
        [...document.querySelectorAll('[role="option"]')].map((el) => el.textContent),
      ).toContain("Newly Installed"),
    );
  });

  it.each(["denied", "unsupported"] as const)(
    "selects an exact family when enumeration is %s",
    async (status) => {
      vi.mocked(queryInstalledFontFamilies).mockResolvedValue({ status, families: [] });
      const onSelect = vi.fn();
      await act(async () =>
        root.render(
          <FontFamilyPicker
            ariaLabel="Interface font"
            defaultFamily="Arial"
            selectedFamily=""
            initialOpen
            onSelect={onSelect}
          />,
        ),
      );
      const input = document.querySelector<HTMLInputElement>(
        'input[placeholder="Search or enter a font…"]',
      )!;
      await typeQuery(input, "Custom Font");
      await vi.waitFor(() => expect(highlightedOptions()).toEqual(["Custom Fontuse exact name"]));
      await act(async () =>
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
      );
      expect(onSelect).toHaveBeenCalledWith("Custom Font");
    },
  );
});
