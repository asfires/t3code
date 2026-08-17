import { describe, expect, it } from "vite-plus/test";

import {
  getThemeColorsForMode,
  themeColorToHex,
  toCanonicalThemeColor,
  THEME_FILE_VERSION,
} from "./themePalette";
import {
  isVsCodeThemeFile,
  pairVsCodeThemes,
  parseVsCodeThemeFile,
  resolveThemeLabelCollisions,
} from "./vscodeThemeImport";

function asHex(value: string): string {
  const hex = themeColorToHex(value);
  if (!hex) throw new Error(`Expected a theme color, received ${value}`);
  return hex;
}

function contrastRatio(first: string, second: string): number {
  const toChannels = (value: string) => {
    const hex = asHex(value).slice(1);
    return [0, 1, 2].map(
      (channel) => Number.parseInt(hex.slice(channel * 2, channel * 2 + 2), 16) / 255,
    );
  };
  const luminance = (value: string) =>
    toChannels(value)
      .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
      .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
  const lighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

// Shaped like a real workbench theme: dotted keys, alpha overlays, and a lot
// of roles simply left out.
const VSCODE_DARK = {
  name: "pierre-dark-soft",
  type: "dark",
  colors: {
    "editor.background": "#171717",
    "editor.foreground": "#d4d4d4",
    foreground: "#d4d4d4",
    "sideBar.background": "#101010",
    "sideBar.foreground": "#8a8a8a",
    "sideBar.border": "#1d1d1d",
    focusBorder: "#69b1ff",
    "button.background": "#69b1ff",
    "button.foreground": "#171717",
    "input.border": "#2c2c2c",
    "input.placeholderForeground": "#525252",
    "terminal.background": "#101010",
    "terminal.foreground": "#8a8a8a",
    "list.hoverBackground": "#1f3e5e59",
    "list.activeSelectionBackground": "#1f3e5e99",
  },
  tokenColors: [],
};

// The Gruvbox Material Dark workbench colors that matter here, verbatim from
// the extension: transparent focus and hover, every widget surface equal to
// the editor, a dim error squiggle ahead of the real red, and a sidebar
// foreground dimmer than the editor's.
const GRUVBOX_MATERIAL_DARK = {
  name: "Gruvbox Material Dark",
  type: "dark",
  colors: {
    "editor.background": "#292828",
    "editor.foreground": "#d4be98",
    foreground: "#a89984",
    descriptionForeground: "#928374",
    focusBorder: "#45403d00",
    "button.background": "#a89984",
    "button.foreground": "#292828",
    "textLink.foreground": "#a9b665",
    "editorWidget.background": "#292828",
    "dropdown.background": "#292828",
    "dropdown.border": "#45403d",
    "menu.background": "#292828",
    "panel.background": "#292828",
    "panel.border": "#292828",
    "input.border": "#45403d",
    "input.placeholderForeground": "#7c6f64",
    "sideBar.background": "#292828",
    "sideBar.foreground": "#928374",
    "list.hoverBackground": "#29282800",
    "list.activeSelectionBackground": "#45403d60",
    "list.inactiveSelectionBackground": "#45403d48",
    "editorError.foreground": "#b85651",
    errorForeground: "#ea6962",
    "editorWarning.foreground": "#c18f41",
    "list.warningForeground": "#d8a657",
    "textCodeBlock.background": "#32302f",
    "terminal.foreground": "#d4be98",
    "terminalCursor.foreground": "#d4be98",
    "scrollbarSlider.background": "#7c6f6480",
  },
  tokenColors: [],
};

function oklchLightness(value: string): number {
  return Number.parseFloat(/^oklch\(([0-9.]+)/.exec(value)?.[1] ?? "NaN");
}

function oklchHue(value: string): number {
  return Number.parseFloat(/^oklch\([0-9.]+ [0-9.]+ ([0-9.]+)/.exec(value)?.[1] ?? "NaN");
}

describe("VS Code theme import", () => {
  it("recognises workbench themes and rejects our own files", () => {
    expect(isVsCodeThemeFile(VSCODE_DARK)).toBe(true);
    expect(isVsCodeThemeFile({ type: "dark", tokenColors: [] })).toBe(true);
    expect(
      isVsCodeThemeFile({
        version: THEME_FILE_VERSION,
        name: "Aurora",
        appearance: "light",
        colors: { canvas: "#ffffff" },
      }),
    ).toBe(false);
    expect(isVsCodeThemeFile("nope")).toBe(false);
  });

  it("carries the editor surfaces and accent across", () => {
    const theme = parseVsCodeThemeFile(VSCODE_DARK);
    // The slug name is read as words; a displayName would win verbatim.
    expect(theme.label).toBe("Pierre Dark Soft");
    expect(theme.appearance).toBe("dark");
    expect(asHex(theme.colors.canvas)).toBe("#171717");
    // Text is the editor foreground carried toward the stock near-white.
    expect(oklchLightness(theme.colors.text)).toBeGreaterThan(
      oklchLightness(toCanonicalThemeColor("#d4d4d4")!),
    );
    expect(asHex(theme.colors.accent)).toBe("#69b1ff");
    expect(asHex(theme.colors.sidebar)).toBe("#101010");
    expect(asHex(theme.colors.terminalBackground)).toBe("#101010");
  });

  it("flattens alpha overlays onto the surface they sit on", () => {
    const theme = parseVsCodeThemeFile(VSCODE_DARK);
    // #1f3e5e59 over the #101010 sidebar, not left semi-transparent.
    expect(theme.colors.sidebarRowHover).toMatch(/^oklch\(/);
    expect(asHex(theme.colors.sidebarRowHover)).not.toBe("#1f3e5e59");
    expect(theme.colors.sidebarRowSelected).not.toBe(theme.colors.sidebar);
  });

  it("fills every role the file omits with a readable derived value", () => {
    const theme = parseVsCodeThemeFile(VSCODE_DARK);
    const colors = getThemeColorsForMode(theme, "dark")!;
    for (const value of Object.values(colors)) {
      expect(value).toMatch(/^oklch\(/);
    }
    expect(contrastRatio(colors.text, colors.canvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colors.sidebarForeground, colors.sidebar)).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(colors.messageActionForeground, colors.messageAction),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("reads a fully transparent color as unset, not as the surface", () => {
    const theme = parseVsCodeThemeFile(GRUVBOX_MATERIAL_DARK);
    // focusBorder #45403d00 would flatten to the canvas; the accent falls
    // through to the button color instead of vanishing.
    expect(asHex(theme.colors.accent)).toBe("#a89984");
    expect(asHex(theme.colors.focus)).toBe("#a89984");
    // list.hoverBackground #29282800 likewise; hover keeps a visible step.
    expect(theme.colors.sidebarRowHover).not.toBe(theme.colors.sidebar);
    expect(contrastRatio(theme.colors.sidebarRowHover, theme.colors.sidebar)).toBeGreaterThan(1.1);
  });

  it("keeps a tonal step when a widget surface equals the canvas", () => {
    const theme = parseVsCodeThemeFile(GRUVBOX_MATERIAL_DARK);
    const canvasL = oklchLightness(theme.colors.canvas);
    const surfaces = [
      theme.colors.surface,
      theme.colors.surfaceRaised,
      theme.colors.surfaceOverlay,
      theme.colors.border,
    ];
    for (const surface of surfaces) {
      expect(surface).not.toBe(theme.colors.canvas);
    }
    // Progressively lighter, the way the stock dark palette stacks.
    const lightness = surfaces.map(oklchLightness);
    for (let index = 0; index < lightness.length; index += 1) {
      expect(lightness[index]!).toBeGreaterThan(index === 0 ? canvasL : lightness[index - 1]!);
    }
    // A surface the theme did distinguish is honored as given.
    expect(asHex(theme.colors.codeBackground)).toBe("#32302f");
    expect(asHex(theme.colors.input)).toBe("#45403d");
  });

  it("builds every derived text color from the theme's own foreground", () => {
    const theme = parseVsCodeThemeFile(GRUVBOX_MATERIAL_DARK);
    // Primary text is the editor foreground pulled toward the stock
    // near-white with its warm hue kept, not the code color verbatim and not
    // a synthesized neutral.
    const seed = toCanonicalThemeColor("#d4be98")!;
    expect(oklchLightness(theme.colors.text)).toBeGreaterThan(oklchLightness(seed) + 0.08);
    expect(Math.abs(oklchHue(theme.colors.text) - oklchHue(seed))).toBeLessThan(6);
    // The sidebar, code, toolbar, and message text all follow it.
    for (const role of [
      "sidebarForeground",
      "codeForeground",
      "toolbarForeground",
      "messageForeground",
      "secondaryForeground",
    ] as const) {
      expect(asHex(theme.colors[role])).toBe(asHex(theme.colors.text));
    }
    // Muted text is a dimmer relative, not body text again.
    for (const role of ["mutedForeground", "placeholder", "textMuted"] as const) {
      expect(contrastRatio(theme.colors[role], theme.colors.canvas)).toBeLessThan(
        contrastRatio(theme.colors.text, theme.colors.canvas),
      );
      expect(contrastRatio(theme.colors[role], theme.colors.canvas)).toBeGreaterThanOrEqual(4.4);
    }
    expect(theme.colors.secondaryLabel).toBe(theme.colors.textMuted);
    expect(theme.colors.iconMuted).toBe(theme.colors.textMuted);
  });

  it("lifts an unreadable color along its own hue instead of replacing it", () => {
    const theme = parseVsCodeThemeFile(GRUVBOX_MATERIAL_DARK);
    // descriptionForeground #928374 is 4.0:1 on the canvas: same warm hue,
    // slightly lighter, rather than a neutral grey.
    const descriptionHue = oklchHue(toCanonicalThemeColor("#928374")!);
    expect(Math.abs(oklchHue(theme.colors.textMuted) - descriptionHue)).toBeLessThan(3);
    expect(contrastRatio(theme.colors.textMuted, theme.colors.canvas)).toBeGreaterThanOrEqual(4.5);
    expect(oklchLightness(theme.colors.textMuted)).toBeGreaterThan(
      oklchLightness(toCanonicalThemeColor("#928374")!),
    );
  });

  it("uses the theme's own status colors, and never white", () => {
    const theme = parseVsCodeThemeFile(GRUVBOX_MATERIAL_DARK);
    // editorError.foreground #b85651 is unreadable on the canvas and used to
    // drag the whole family down to a white fallback; the readable red wins.
    expect(asHex(theme.colors.error)).toBe("#ea6962");
    expect(asHex(theme.colors.warning)).toBe("#d8a657");
    // Surfaces and foregrounds follow the theme's signal, not the standard.
    expect(
      Math.abs(oklchHue(theme.colors.errorForeground) - oklchHue(theme.colors.error)),
    ).toBeLessThan(3);
    expect(
      Math.abs(oklchHue(theme.colors.warningForeground) - oklchHue(theme.colors.warning)),
    ).toBeLessThan(3);
    expect(
      contrastRatio(theme.colors.errorForeground, theme.colors.errorSurface),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(theme.colors.warningForeground, theme.colors.warningSurface),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("derives the action hover and update family from the colors that won", () => {
    const theme = parseVsCodeThemeFile(GRUVBOX_MATERIAL_DARK);
    expect(asHex(theme.colors.messageAction)).toBe("#a89984");
    expect(theme.colors.messageActionHover).not.toBe(theme.colors.messageAction);
    expect(
      Math.abs(oklchHue(theme.colors.messageActionHover) - oklchHue(theme.colors.messageAction)),
    ).toBeLessThan(3);
    expect(asHex(theme.colors.update)).toBe("#a89984");
    expect(theme.colors.updateSurface).not.toBe(theme.colors.canvas);
  });

  it("maps a dim sideBar.foreground to secondary sidebar text, never a bright one", () => {
    const dim = parseVsCodeThemeFile(GRUVBOX_MATERIAL_DARK);
    expect(contrastRatio(dim.colors.sidebarMutedForeground, dim.colors.sidebar)).toBeLessThan(
      contrastRatio(dim.colors.sidebarForeground, dim.colors.sidebar),
    );
    expect(
      Math.abs(
        oklchHue(dim.colors.sidebarMutedForeground) - oklchHue(toCanonicalThemeColor("#928374")!),
      ),
    ).toBeLessThan(3);
    // A theme whose sidebar text is full strength keeps the hierarchy.
    const bright = parseVsCodeThemeFile({
      ...GRUVBOX_MATERIAL_DARK,
      colors: { ...GRUVBOX_MATERIAL_DARK.colors, "sideBar.foreground": "#d4be98" },
    });
    expect(contrastRatio(bright.colors.sidebarMutedForeground, bright.colors.sidebar)).toBeLessThan(
      contrastRatio(bright.colors.sidebarForeground, bright.colors.sidebar) * 0.9,
    );
  });

  it("prefers an accent that clears 3:1 over a barely visible focus ring", () => {
    // Nord and One Dark put a near-canvas grey in focusBorder; the link and
    // button colors carry the accent people recognize.
    const theme = parseVsCodeThemeFile({
      name: "Nordish",
      type: "dark",
      colors: {
        "editor.background": "#2e3440",
        "editor.foreground": "#d8dee9",
        focusBorder: "#3b4252",
        "button.background": "#88c0d0",
      },
    });
    expect(asHex(theme.colors.accent)).toBe("#88c0d0");
    // With no candidate clearing 3:1 the first visible one still wins.
    const dim = parseVsCodeThemeFile({
      name: "Dim",
      type: "dark",
      colors: { "editor.background": "#2e3440", focusBorder: "#3b4252" },
    });
    expect(asHex(dim.colors.accent)).toBe("#3b4252");
  });

  it("skips a status color that is not a signal", () => {
    // Solarized's errorForeground is the pale pink of message text; taking
    // it as the theme's red would paint destructive buttons near-white.
    const theme = parseVsCodeThemeFile({
      name: "Solarish",
      type: "dark",
      colors: {
        "editor.background": "#002b36",
        "editor.foreground": "#839496",
        errorForeground: "#ffeaea",
      },
    });
    expect(asHex(theme.colors.error)).not.toBe("#ffeaea");
    expect(contrastRatio(theme.colors.error, theme.colors.canvas)).toBeGreaterThanOrEqual(4.5);
    const hue = oklchHue(theme.colors.error);
    expect(hue < 40 || hue > 340).toBe(true);
  });

  it("does not let a full-strength descriptionForeground flatten muted text", () => {
    // One Dark Pro sets descriptionForeground to the editor foreground.
    const theme = parseVsCodeThemeFile({
      name: "One Darkish",
      type: "dark",
      colors: {
        "editor.background": "#282c34",
        "editor.foreground": "#abb2bf",
        descriptionForeground: "#abb2bf",
        "input.placeholderForeground": "#abb2bf",
      },
    });
    for (const role of ["textMuted", "placeholder", "mutedForeground"] as const) {
      expect(contrastRatio(theme.colors[role], theme.colors.canvas)).toBeLessThan(
        contrastRatio(theme.colors.text, theme.colors.canvas) * 0.9,
      );
    }
  });

  it("pulls heavy borders back to hairline weight, keeping their hue", () => {
    // Catppuccin Mocha: panel.border is surface2, three steps above the
    // base, and dropdown.border is the mauve accent.
    const theme = parseVsCodeThemeFile({
      name: "Catppuccin Mocha",
      type: "dark",
      colors: {
        "editor.background": "#1e1e2e",
        "editor.foreground": "#cdd6f4",
        focusBorder: "#cba6f7",
        "panel.border": "#585b70",
        "input.border": "#00000000",
        "dropdown.border": "#cba6f7",
      },
    });
    const canvasL = oklchLightness(theme.colors.canvas);
    for (const role of ["border", "input", "sidebarBorder", "toolbarBorder"] as const) {
      const base = role === "sidebarBorder" ? theme.colors.sidebar : theme.colors.canvas;
      expect(oklchLightness(theme.colors[role]) - oklchLightness(base)).toBeLessThanOrEqual(0.115);
      expect(oklchLightness(theme.colors[role])).toBeGreaterThan(oklchLightness(base) + 0.04);
    }
    // The border keeps surface2's cool hue rather than turning neutral.
    expect(
      Math.abs(oklchHue(theme.colors.border) - oklchHue(toCanonicalThemeColor("#585b70")!)),
    ).toBeLessThan(15);
    // The accent-colored dropdown border never becomes the input outline.
    expect(asHex(theme.colors.input)).not.toBe("#cba6f7");
    expect(oklchLightness(theme.colors.input)).toBeLessThan(canvasL + 0.115);
    // A border already at hairline weight is left as the theme wrote it.
    const gruvbox = parseVsCodeThemeFile(GRUVBOX_MATERIAL_DARK);
    expect(asHex(gruvbox.colors.input)).toBe("#45403d");
  });

  it("honors a quiet hover the theme steps below its sidebar", () => {
    // Tokyo Night hovers 0.014 OKLab darker than the sidebar; that is a
    // choice, not the same color.
    const theme = parseVsCodeThemeFile({
      name: "Tokyo Nightish",
      type: "dark",
      colors: {
        "editor.background": "#1a1b26",
        "editor.foreground": "#a9b1d6",
        "sideBar.background": "#16161e",
        "list.hoverBackground": "#13131a",
      },
    });
    expect(asHex(theme.colors.sidebarRowHover)).toBe("#13131a");
  });

  it("keeps derived surfaces in a tinted canvas's own family", () => {
    // Gruvbox Material Light: a cream canvas with a near-neutral accent. The
    // derived hover and popover step into deeper cream, not grey.
    const theme = parseVsCodeThemeFile({
      name: "Gruvbox Material Light",
      type: "light",
      colors: {
        "editor.background": "#fbf1c7",
        "editor.foreground": "#654735",
        "button.background": "#7c6f64",
        "menu.background": "#fbf1c7",
        "list.hoverBackground": "#fbf1c700",
      },
    });
    const canvasHue = oklchHue(theme.colors.canvas);
    const chroma = (value: string) =>
      Number.parseFloat(/^oklch\([0-9.]+ ([0-9.]+)/.exec(value)?.[1] ?? "NaN");
    const canvasChroma = chroma(theme.colors.canvas);
    for (const role of ["surfaceOverlay", "sidebarRowHover", "surfaceRaised", "muted"] as const) {
      expect(Math.abs(oklchHue(theme.colors[role]) - canvasHue)).toBeLessThan(6);
      expect(chroma(theme.colors[role])).toBeGreaterThanOrEqual(canvasChroma - 0.002);
      expect(theme.colors[role]).not.toBe(theme.colors.canvas);
    }
  });

  it("keeps the list highlight a visible step off the popover it sits on", () => {
    // Gruvbox Dark Hard: the selection color sits at the same tone as the
    // derived popover surface, so the hovered file in the mention picker
    // vanished.
    const theme = parseVsCodeThemeFile({
      name: "Gruvbox Dark Hard",
      type: "dark",
      colors: {
        "editor.background": "#1d2021",
        "editor.foreground": "#ebdbb2",
        "menu.background": "#1d2021",
        "list.activeSelectionBackground": "#3c383680",
      },
    });
    expect(
      Math.abs(
        oklchLightness(theme.colors.accentSurface) - oklchLightness(theme.colors.surfaceOverlay),
      ),
    ).toBeGreaterThanOrEqual(0.039);
    expect(
      contrastRatio(theme.colors.accentSurfaceForeground, theme.colors.accentSurface),
    ).toBeGreaterThanOrEqual(4.5);
    // A highlight that already clears the popover is left alone (Catppuccin: mantle popover, surface0 highlight).
    const catppuccin = parseVsCodeThemeFile({
      name: "Mocha",
      type: "dark",
      colors: {
        "editor.background": "#1e1e2e",
        "menu.background": "#181825",
        "list.activeSelectionBackground": "#313244",
      },
    });
    expect(asHex(catppuccin.colors.accentSurface)).toBe("#313244");
  });

  it("falls back to the editor background when the type is missing or odd", () => {
    const untyped = parseVsCodeThemeFile({
      name: "Untyped",
      colors: { "editor.background": "#fdfdfd", "editor.foreground": "#202020" },
    });
    expect(untyped.appearance).toBe("light");
    const hc = parseVsCodeThemeFile({
      name: "High contrast",
      type: "hc-light",
      colors: { "editor.background": "#ffffff" },
    });
    expect(hc.appearance).toBe("light");
  });

  it("keeps an unreadable foreground out of the palette", () => {
    const theme = parseVsCodeThemeFile({
      name: "Unreadable",
      type: "dark",
      colors: { "editor.background": "#101010", "editor.foreground": "#111111" },
    });
    expect(asHex(theme.colors.text)).not.toBe("#111111");
    expect(contrastRatio(theme.colors.text, theme.colors.canvas)).toBeGreaterThanOrEqual(4.5);
  });

  it("stays readable when the file replaces a surface but not its foreground", () => {
    // A dark theme with a light sidebar: the derived sidebar foreground was
    // solved for a dark surface and would vanish on this one.
    const theme = parseVsCodeThemeFile({
      name: "Split",
      type: "dark",
      colors: {
        "editor.background": "#101010",
        "editor.foreground": "#f5f5f5",
        "sideBar.background": "#fafafa",
        "terminal.background": "#fbfbfb",
      },
    });
    expect(asHex(theme.colors.sidebar)).toBe("#fafafa");
    expect(
      contrastRatio(theme.colors.sidebarForeground, theme.colors.sidebar),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(theme.colors.terminalForeground, theme.colors.terminalBackground),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("reads wide-gamut color() notation", () => {
    // Themes authored for P3 displays (the shipped Pierre "vibrant" pair) use
    // this instead of hex.
    const theme = parseVsCodeThemeFile({
      name: "Vibrant",
      type: "dark",
      colors: {
        "editor.background": "color(display-p3 0.039216 0.039216 0.039216)",
        "editor.foreground": "color(display-p3 0.980392 0.980392 0.980392)",
        focusBorder: "color(display-p3 0.308664 0.645271 1.000000)",
        "editor.selectionBackground": "color(display-p3 0.308664 0.645271 1.000000 / 0.300000)",
      },
    });
    expect(asHex(theme.colors.canvas)).toMatch(/^#0[89ab]/);
    expect(asHex(theme.colors.text)).toMatch(/^#f[a-f0-9]/);
    // The P3 blue lands in sRGB blue, not black or a clipped grey.
    const accent = asHex(theme.colors.accent);
    const [red, green, blue] = [1, 3, 5].map((index) =>
      Number.parseInt(accent.slice(index, index + 2), 16),
    ) as [number, number, number];
    expect(blue).toBeGreaterThan(200);
    expect(blue).toBeGreaterThan(red);
    expect(green).toBeGreaterThan(red);
  });

  it("pairs light and dark files from one family into dual-mode themes", () => {
    const make = (name: string, type: "light" | "dark") =>
      parseVsCodeThemeFile({
        name,
        type,
        colors: {
          "editor.background": type === "dark" ? "#101014" : "#fdfdfd",
          "editor.foreground": type === "dark" ? "#e6e6e6" : "#1f1f1f",
          focusBorder: "#69b1ff",
        },
      });
    const themes = pairVsCodeThemes([
      make("github-dark", "dark"),
      make("github-light", "light"),
      make("github-dark-colorblind", "dark"),
      make("github-light-colorblind", "light"),
      make("github-dark-dimmed", "dark"),
    ]);

    const labels = themes.map((theme) => theme.label);
    expect(labels).toEqual(["Github", "Github Colorblind", "Github Dark Dimmed"]);
    const github = themes[0]!;
    expect(github.appearance).toBe("light");
    expect(getThemeColorsForMode(github, "dark")).not.toBeNull();
    expect(asHex(getThemeColorsForMode(github, "dark")!.canvas)).toBe("#101014");
    expect(asHex(github.colors.canvas)).toBe("#fdfdfd");
    // The unpaired dimmed variant stays a single dark theme.
    expect(getThemeColorsForMode(themes[2]!, "light")).toBeNull();
  });

  it("does not guess when a family is ambiguous", () => {
    const make = (name: string, type: "light" | "dark") =>
      parseVsCodeThemeFile({
        name,
        type,
        colors: { "editor.background": type === "dark" ? "#101014" : "#fdfdfd" },
      });
    const themes = pairVsCodeThemes([
      make("solar-dark", "dark"),
      make("solar-dark-soft", "dark"),
      make("solar-light", "light"),
    ]);
    // "solar-dark-soft" groups under its own key with no light partner, so
    // it keeps its full name; the remaining pair merges.
    expect(themes.map((theme) => theme.label).sort()).toEqual(["Solar", "Solar Dark Soft"]);
  });

  it("keeps derived surfaces neutral instead of washing them with the accent", () => {
    // A gray theme with a blue focusBorder: roles the file omits (code
    // surface, plain surfaces) must stay near the canvas, not turn blue.
    const theme = parseVsCodeThemeFile(VSCODE_DARK);
    const spread = (value: string) => {
      const hex = asHex(value);
      const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
      return Math.max(...channels) - Math.min(...channels);
    };
    expect(spread(theme.colors.codeBackground)).toBeLessThanOrEqual(8);
    expect(spread(theme.colors.surface)).toBeLessThanOrEqual(8);
    expect(spread(theme.colors.text)).toBeLessThanOrEqual(12);
    // The accent itself keeps the file's color.
    expect(asHex(theme.colors.accent)).toBe("#69b1ff");
  });

  it("tells same-named variants apart by their file names", () => {
    // Dracula ships dracula.json and dracula-soft.json that both say
    // "Dracula" inside.
    const dracula = (bg: string) =>
      parseVsCodeThemeFile({
        name: "Dracula",
        type: "dark",
        colors: { "editor.background": bg, "editor.foreground": "#f8f8f2" },
      });
    const themes = resolveThemeLabelCollisions([
      { theme: dracula("#282a36"), sourceName: "dracula.json" },
      { theme: dracula("#22232e"), sourceName: "dracula-soft.json" },
    ]);
    expect(themes.map((theme) => theme.label)).toEqual(["Dracula", "Dracula Soft"]);
    expect(themes.map((theme) => theme.id)).toEqual(["dracula", "dracula-soft"]);
    // Without file names the second falls back to numbering.
    const numbered = resolveThemeLabelCollisions([
      { theme: dracula("#282a36") },
      { theme: dracula("#22232e") },
    ]);
    expect(numbered.map((theme) => theme.label)).toEqual(["Dracula", "Dracula 2"]);
  });

  it("falls back to the name when the displayName humanizes to nothing", () => {
    const theme = parseVsCodeThemeFile({
      displayName: "---",
      name: "night-owl",
      type: "dark",
      colors: { "editor.background": "#011627" },
    });
    expect(theme.label).toBe("Night Owl");
  });

  it("keeps a pair whose stripped name is reserved as two single themes", () => {
    const make = (name: string, type: "light" | "dark") =>
      parseVsCodeThemeFile({
        name,
        type,
        colors: { "editor.background": type === "dark" ? "#101014" : "#fdfdfd" },
      });
    const themes = pairVsCodeThemes([make("grove-light", "light"), make("grove-dark", "dark")]);
    expect(themes.map((theme) => theme.label).sort()).toEqual(["Grove Dark", "Grove Light"]);
  });

  it("explains a file with no editor background", () => {
    expect(() => parseVsCodeThemeFile({ name: "Empty", type: "dark", colors: {} })).toThrow(
      /editor\.background/,
    );
  });
});
