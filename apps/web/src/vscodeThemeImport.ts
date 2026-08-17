import {
  createThemeStatusColors,
  createVividThemeColors,
  getThemeModes,
  limitThemeColorStep,
  parseThemeFile,
  readableThemeColorOn,
  shiftThemeColorLightness,
  themeColorChroma,
  themeColorDistance,
  themeColorLightness,
  themeColorToHex,
  THEME_FILE_VERSION,
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeDefinition,
} from "./themePalette";

/**
 * Best-effort import of a VS Code color theme (`*-color-theme.json`).
 *
 * VS Code themes describe editor chrome, not an app palette: they carry a few
 * hundred workbench keys, leave most of them unset, and freely use 8-digit
 * hex with alpha for overlays. So the conversion derives a complete, contrast
 * -solved palette from the theme's editor background and accent, then layers
 * the workbench colors it did specify on top. Anything the file omits keeps
 * the derived value instead of falling back to an unrelated palette.
 */

type VsCodeRgba = { r: number; g: number; b: number; a: number };
type VsCodeRgb = { r: number; g: number; b: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** sRGB transfer function, and its inverse, shared by the wide-gamut path. */
function decodeGamma(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function encodeGamma(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

/**
 * `color(display-p3 r g b / a)` shows up in themes authored for wide-gamut
 * displays. Out-of-gamut colors clip to the sRGB edge, which is what a browser
 * on an sRGB screen shows anyway.
 */
function parseColorFunction(value: string): VsCodeRgba | null {
  const match = /^color\(\s*(display-p3|srgb)\s+([^)]+)\)$/i.exec(value);
  if (!match) return null;
  const [space, body] = [match[1]!.toLowerCase(), match[2]!];
  const [channelPart, alphaPart] = body.split("/");
  const channels = channelPart!
    .trim()
    .split(/\s+/)
    .map((part) => (part.endsWith("%") ? Number.parseFloat(part) / 100 : Number.parseFloat(part)));
  if (channels.length !== 3 || channels.some((channel) => !Number.isFinite(channel))) return null;
  const alphaRaw = alphaPart?.trim();
  const alpha =
    alphaRaw === undefined
      ? 1
      : alphaRaw.endsWith("%")
        ? Number.parseFloat(alphaRaw) / 100
        : Number.parseFloat(alphaRaw);
  if (!Number.isFinite(alpha)) return null;

  const [red, green, blue] = channels as [number, number, number];
  if (space === "srgb") {
    return { r: red * 255, g: green * 255, b: blue * 255, a: Math.max(0, Math.min(1, alpha)) };
  }
  const [linearRed, linearGreen, linearBlue] = [red, green, blue].map(decodeGamma) as [
    number,
    number,
    number,
  ];
  // Display P3 linear -> sRGB linear.
  const srgb = [
    1.2249401762805 * linearRed - 0.2249401762805 * linearGreen,
    -0.042056961239 * linearRed + 1.042056961239 * linearGreen,
    -0.0196375547643 * linearRed - 0.0786360655012 * linearGreen + 1.0982736202656 * linearBlue,
  ].map((channel) => encodeGamma(channel) * 255) as [number, number, number];
  return { r: srgb[0], g: srgb[1], b: srgb[2], a: Math.max(0, Math.min(1, alpha)) };
}

/** VS Code accepts #RGB, #RGBA, #RRGGBB, and #RRGGBBAA; some themes also use
 *  CSS color() notation for wide-gamut palettes. */
function parseVsCodeColor(value: unknown): VsCodeRgba | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.startsWith("color(")) return parseColorFunction(trimmed);
  const hex = trimmed.replace(/^#/, "");
  if (!/^(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) return null;
  const expand = (part: string) =>
    part.length === 1 ? Number.parseInt(part + part, 16) : Number.parseInt(part, 16);
  if (hex.length <= 4) {
    return {
      r: expand(hex[0]!),
      g: expand(hex[1]!),
      b: expand(hex[2]!),
      a: hex.length === 4 ? expand(hex[3]!) / 255 : 1,
    };
  }
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
    a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
  };
}

function toHex(color: VsCodeRgb): string {
  const channel = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

/** Overlays are semi-transparent in VS Code; our roles are opaque, so they are
 *  composited onto whatever surface they sit on. */
function flattenOver(color: VsCodeRgba, base: VsCodeRgb): string {
  if (color.a >= 1) return toHex(color);
  return toHex({
    r: color.r * color.a + base.r * (1 - color.a),
    g: color.g * color.a + base.g * (1 - color.a),
    b: color.b * color.a + base.b * (1 - color.a),
  });
}

function relativeLuminance(color: VsCodeRgb): number {
  const channel = (value: number) => {
    const ratio = value / 255;
    return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function contrastRatio(first: VsCodeRgb, second: VsCodeRgb): number {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function hexToRgb(value: string): VsCodeRgb {
  return parseVsCodeColor(themeColorToHex(value) ?? value) ?? { r: 0, g: 0, b: 0, a: 1 };
}

/**
 * A VS Code theme is recognised by its workbench colors: the keys are dotted
 * paths (`editor.background`), which our own files never use.
 */
export function isVsCodeThemeFile(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.version === THEME_FILE_VERSION) return false;
  const hasWorkbenchColors =
    isRecord(value.colors) && Object.keys(value.colors).some((key) => key.includes("."));
  return hasWorkbenchColors || Array.isArray(value.tokenColors);
}

function resolveAppearance(value: Record<string, unknown>, canvas: VsCodeRgb): ThemeAppearance {
  const type = typeof value.type === "string" ? value.type.toLowerCase() : null;
  if (type === "light" || type === "hc-light") return "light";
  if (type === "dark" || type === "hc-black") return "dark";
  // Unlabelled themes (and the odd custom `type`) follow the editor surface.
  return relativeLuminance(canvas) < 0.179 ? "dark" : "light";
}

/** Extension `name` fields are often package slugs; read them as words. */
export function humanizeThemeName(raw: string): string {
  const trimmed = raw.trim();
  if (/\s/.test(trimmed) || !/[-_.]/.test(trimmed)) return trimmed;
  return trimmed
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function resolveName(value: Record<string, unknown>): string {
  // Judge candidates by their humanized form: a displayName of "---"
  // humanizes to nothing and must fall through to the name.
  for (const candidate of [value.displayName, value.name]) {
    if (typeof candidate !== "string") continue;
    const humanized = humanizeThemeName(candidate);
    if (humanized.length > 0) return humanized.slice(0, 48);
  }
  return "VS Code theme";
}

/**
 * Fully transparent workbench colors are how VS Code themes hide a focus ring
 * or a hover; they mean "none", not "the surface color", so they read as
 * unset. Anything this faint flattens to the surface it sits on anyway.
 */
const MIN_VISIBLE_ALPHA = 0.02;

/**
 * Below this OKLab distance two surfaces are the same color. VS Code themes
 * routinely give widgets, menus, and borders the editor color and lean on
 * shadows and border keys for separation; our surfaces separate by tone, so
 * an identical color would erase the step rather than restyle it. The bar is
 * deliberately low: a theme's quiet hover (Tokyo Night steps its list hover
 * 0.014 below the sidebar) is a choice to honor, not noise.
 */
const MIN_SURFACE_DISTANCE = 0.008;

/**
 * Borders are hairlines here: the stock palettes keep them within about 0.07
 * to 0.09 lightness of the surface they outline. VS Code themes size their
 * border keys for one line between two panes (Catppuccin's `panel.border` is
 * three surface steps up), and that weight around every card and the composer
 * reads as heavy, so border roles are pulled back to this step.
 */
const MAX_HAIRLINE_STEP = 0.11;

/**
 * A list highlight (the hovered row in a menu or the mention picker) is drawn
 * on the popover surface, not the canvas, and has to clear it by a visible
 * step. The unthemed app uses a 4% white wash, about this much lightness.
 * Themes size `list.activeSelectionBackground` against their editor, so on
 * a popover one derived step up it can land on exactly the same tone.
 */
const MIN_HIGHLIGHT_STEP = 0.04;

/**
 * A status color has to be a signal: below this OKLCH chroma it is a tint
 * (Solarized's `errorForeground` is a pale pink for message text), not the
 * theme's red or amber.
 */
const MIN_STATUS_CHROMA = 0.05;

/**
 * Secondary text only counts as the theme's muted color while it is clearly
 * dimmer than body text (the stock palettes sit near 0.3 of the text
 * contrast); a theme that sets `descriptionForeground` to its editor
 * foreground would otherwise flatten every label to full strength.
 */
const MUTED_CONTRAST_RATIO = 0.6;

export function parseVsCodeThemeFile(value: unknown): ThemeDefinition {
  if (!isRecord(value)) throw new Error("Theme files must contain a JSON object.");
  const colors = isRecord(value.colors) ? value.colors : {};

  /** Every usable (parseable, not transparent) color among `keys`, in priority order. */
  const candidates = (...keys: ReadonlyArray<string>): VsCodeRgba[] =>
    keys
      .map((key) => parseVsCodeColor(colors[key]))
      .filter((parsed): parsed is VsCodeRgba => parsed !== null && parsed.a >= MIN_VISIBLE_ALPHA);
  const pick = (...keys: ReadonlyArray<string>): VsCodeRgba | null =>
    candidates(...keys)[0] ?? null;
  const solidOver = (base: VsCodeRgb, ...keys: ReadonlyArray<string>): string | null => {
    const parsed = pick(...keys);
    return parsed ? flattenOver(parsed, base) : null;
  };
  /** First specified color that is actually distinguishable from `base` once flattened onto it. */
  const distinctOver = (base: VsCodeRgb, ...keys: ReadonlyArray<string>): string | null => {
    const baseHex = toHex(base);
    for (const parsed of candidates(...keys)) {
      const flattened = flattenOver(parsed, base);
      if (themeColorDistance(flattened, baseHex) >= MIN_SURFACE_DISTANCE) return flattened;
    }
    return null;
  };

  const canvasColor = pick("editor.background", "editorPane.background");
  if (!canvasColor) {
    throw new Error(
      'That VS Code theme has no "editor.background" color, so there is nothing to build a palette from.',
    );
  }
  const canvas = { r: canvasColor.r, g: canvasColor.g, b: canvasColor.b };
  const canvasHex = toHex(canvas);
  const appearance = resolveAppearance(value, canvas);
  const dark = relativeLuminance(canvas) < 0.179;

  // The accent has to show: a focus ring or badge wants WCAG's 3:1 non-text
  // contrast, and themes like Nord and One Dark put a barely-there grey in
  // `focusBorder` while the link and button carry the real color. When
  // nothing clears 3:1, the first visible candidate still beats none.
  const accentKeys = [
    "focusBorder",
    "button.background",
    "textLink.foreground",
    "activityBarBadge.background",
    "progressBar.background",
    "badge.background",
  ];
  const accentHex =
    candidates(...accentKeys)
      .map((parsed) => flattenOver(parsed, canvas))
      .find((candidate) => contrastRatio(hexToRgb(candidate), canvas) >= 3) ??
    distinctOver(canvas, ...accentKeys);
  const foregroundHex = solidOver(canvas, "editor.foreground", "foreground");

  // The derived palette is the floor: every role starts contrast-solved, then
  // the theme's own workbench colors replace what it actually specified. The
  // floor derives from a muted accent -- the vivid engine carries the accent
  // hue into every surface, which washes an imported neutral palette (a gray
  // theme with a blue focusBorder would get blue code and text surfaces) --
  // and from the theme's own foreground, so every derived text color is a
  // relative of the text the theme chose rather than a synthesized neutral.
  const mutedAccentHex = accentHex ? flattenOver({ ...hexToRgb(accentHex), a: 0.2 }, canvas) : null;
  const textOptions = foregroundHex ? { text: foregroundHex } : {};
  const derived = createVividThemeColors(
    appearance,
    canvasHex,
    mutedAccentHex ?? canvasHex,
    textOptions,
  );
  // The accent family (update pills, banners) wants the real accent, which
  // the muted floor deliberately does not carry.
  const accented = accentHex
    ? createVividThemeColors(appearance, canvasHex, accentHex, textOptions)
    : derived;

  const sidebarHex =
    solidOver(canvas, "sideBar.background", "activityBar.background") ?? derived.sidebar;
  const sidebar = hexToRgb(sidebarHex);
  const terminalHex =
    solidOver(canvas, "terminal.background", "panel.background") ?? derived.terminalBackground;
  const terminal = hexToRgb(terminalHex);

  /**
   * Foregrounds only win when they stay readable on the surface they land
   * on. The first readable candidate wins; when none clears the bar, the
   * theme's first choice is lifted along its own hue until it does, and only
   * a theme that specified nothing falls back to the derived value (lifted
   * the same way when the file replaced the surface it was solved against).
   */
  const readableOn = (
    surface: string,
    fallback: string,
    keys: ReadonlyArray<string>,
    accept: (candidate: string) => boolean = () => true,
  ): string => {
    const surfaceRgb = hexToRgb(surface);
    const specified = candidates(...keys)
      .map((parsed) => flattenOver(parsed, surfaceRgb))
      .filter(accept);
    const readable = specified.find(
      (candidate) => contrastRatio(hexToRgb(candidate), surfaceRgb) >= 4.5,
    );
    if (readable) return readable;
    return readableThemeColorOn(specified[0] ?? fallback, surface);
  };
  /** Secondary text must sit noticeably below `primary` on `surface` to count as muted. */
  const dimmerThan =
    (primary: string, surface: string) =>
    (candidate: string): boolean =>
      contrastRatio(hexToRgb(candidate), hexToRgb(surface)) <
      contrastRatio(hexToRgb(primary), hexToRgb(surface)) * MUTED_CONTRAST_RATIO;
  const hairlineOn = (surface: string, value: string): string =>
    limitThemeColorStep(value, surface, MAX_HAIRLINE_STEP);
  /** Push a highlight off `surface` (away from the canvas) until it shows. */
  const highlightOn = (surface: string, value: string): string => {
    const delta = themeColorLightness(value) - themeColorLightness(surface);
    if (Math.abs(delta) >= MIN_HIGHLIGHT_STEP) return value;
    return shiftThemeColorLightness(value, (dark ? 1 : -1) * MIN_HIGHLIGHT_STEP - delta);
  };
  const chromatic = (candidate: string): boolean =>
    themeColorChroma(candidate) >= MIN_STATUS_CHROMA;

  const text = derived.text;
  // Our sidebar text is the app's body text (the unthemed app aliases them);
  // VS Code's `sideBar.foreground` is the dimmer tree-item color, which maps
  // to our secondary sidebar text -- but only while it is actually dimmer,
  // or a theme that sets it to full strength would flatten the hierarchy.
  const sidebarForeground = readableThemeColorOn(text, sidebarHex);
  const sidebarMutedForeground = readableOn(
    sidebarHex,
    derived.sidebarMutedForeground,
    ["sideBar.foreground", "descriptionForeground"],
    dimmerThan(sidebarForeground, sidebarHex),
  );

  // Status colors: the theme's own red and amber when it has them, lifted to
  // read on the canvas, and their surfaces and foregrounds follow suit so a
  // theme is not half its own palette and half ours.
  const errorHex = readableOn(
    canvasHex,
    derived.error,
    ["errorForeground", "list.errorForeground", "editorError.foreground"],
    chromatic,
  );
  const warningHex = readableOn(
    canvasHex,
    derived.warning,
    ["list.warningForeground", "editorWarning.foreground", "problemsWarningIcon.foreground"],
    chromatic,
  );
  const status = createThemeStatusColors(canvasHex, { error: errorHex, warning: warningHex });

  const textMuted = readableOn(
    canvasHex,
    derived.textMuted,
    ["descriptionForeground", "disabledForeground"],
    dimmerThan(text, canvasHex),
  );
  const surfaceOverlay =
    distinctOver(canvas, "menu.background", "quickInput.background", "dropdown.background") ??
    derived.surfaceOverlay;
  const accentSurface = highlightOn(
    surfaceOverlay,
    distinctOver(canvas, "list.activeSelectionBackground", "list.hoverBackground") ??
      derived.accentSurface,
  );
  const overrides: Partial<Record<ThemeColorRole, string>> = {
    ...status,
    canvas: canvasHex,
    text,
    textMuted,
    // The stock palettes use one muted color for labels, icons, and text on
    // muted surfaces; the theme's choice carries to all of them.
    secondaryLabel: textMuted,
    iconMuted: textMuted,
    mutedForeground: readableThemeColorOn(textMuted, derived.muted),
    surface: distinctOver(canvas, "editorWidget.background") ?? derived.surface,
    surfaceRaised:
      distinctOver(canvas, "editorWidget.background", "dropdown.background") ??
      derived.surfaceRaised,
    surfaceOverlay,
    border: hairlineOn(
      canvasHex,
      distinctOver(canvas, "panel.border", "contrastBorder") ?? derived.border,
    ),
    // `dropdown.border` is usually the accent (a dropdown is a button); our
    // input outline is the quiet edge of the composer and text fields.
    input: hairlineOn(canvasHex, distinctOver(canvas, "input.border") ?? derived.input),
    toolbarBorder: hairlineOn(canvasHex, derived.toolbarBorder),
    placeholder: readableOn(
      canvasHex,
      derived.placeholder,
      ["input.placeholderForeground"],
      dimmerThan(text, canvasHex),
    ),
    accentSurface,
    accentSurfaceForeground: readableThemeColorOn(text, accentSurface),
    codeBackground: distinctOver(canvas, "textCodeBlock.background") ?? derived.codeBackground,
    sidebar: sidebarHex,
    sidebarForeground,
    sidebarMutedForeground,
    sidebarBorder: hairlineOn(
      sidebarHex,
      distinctOver(sidebar, "sideBar.border") ?? derived.sidebarBorder,
    ),
    sidebarRowHover: distinctOver(sidebar, "list.hoverBackground") ?? derived.sidebarRowHover,
    sidebarRowActive:
      distinctOver(sidebar, "list.inactiveSelectionBackground", "list.hoverBackground") ??
      derived.sidebarRowActive,
    sidebarRowSelected:
      distinctOver(sidebar, "list.activeSelectionBackground") ?? derived.sidebarRowSelected,
    terminalBackground: terminalHex,
    terminalForeground: readableOn(terminalHex, derived.terminalForeground, [
      "terminal.foreground",
    ]),
    terminalCursor:
      solidOver(terminal, "terminalCursor.foreground", "editorCursor.foreground") ??
      derived.terminalCursor,
    terminalSelection:
      distinctOver(terminal, "terminal.selectionBackground", "editor.selectionBackground") ??
      derived.terminalSelection,
    terminalScrollbar:
      distinctOver(terminal, "scrollbarSlider.background") ?? derived.terminalScrollbar,
  };
  if (accentHex) {
    overrides.accent = accentHex;
    overrides.focus = accentHex;
    overrides.update = accented.update;
    overrides.updateForeground = accented.updateForeground;
    overrides.updateSurface = accented.updateSurface;
    overrides.accentForeground = readableOn(accentHex, derived.accentForeground, [
      "button.foreground",
    ]);
    // The button pair is the closest thing VS Code has to our action color,
    // and its hover state is a lightness step off whichever color won.
    const actionHex = solidOver(canvas, "button.background") ?? accentHex;
    overrides.messageAction = actionHex;
    overrides.messageActionForeground = readableOn(actionHex, derived.messageActionForeground, [
      "button.foreground",
    ]);
    overrides.messageActionHover = shiftThemeColorLightness(actionHex, dark ? 0.06 : -0.06);
  }

  // Reuse the theme-file parser so ids, names, and color values go through the
  // same validation as a hand-written file.
  return parseThemeFile({
    version: THEME_FILE_VERSION,
    name: resolveName(value),
    appearance,
    colors: { ...derived, ...overrides },
  });
}

/**
 * Extensions ship a family of themes (GitHub: dark, light, dark-colorblind,
 * light-colorblind, dark-dimmed, ...). When several are imported together,
 * a light and a dark file whose names differ only by the appearance word
 * become one dual-mode theme; everything else stays its own theme.
 */
export function pairVsCodeThemes(
  themes: ReadonlyArray<ThemeDefinition>,
  options?: {
    pairedId?: (light: ThemeDefinition, dark: ThemeDefinition) => string;
  },
): ReadonlyArray<ThemeDefinition> {
  const stripAppearance = (label: string) =>
    label
      .replace(/\b(?:light|dark)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

  type Group = { light: ThemeDefinition[]; dark: ThemeDefinition[]; order: number };
  const groups = new Map<string, Group>();
  const passthrough: Array<{ theme: ThemeDefinition; order: number }> = [];
  themes.forEach((theme, order) => {
    // Only single-appearance themes with an appearance word in the name can
    // pair; anything else is already what the user asked for.
    const key = stripAppearance(theme.label);
    if (getThemeModes(theme).length !== 1 || key === theme.label || key.length === 0) {
      passthrough.push({ theme, order });
      return;
    }
    const group = groups.get(key) ?? { light: [], dark: [], order };
    group[theme.appearance].push(theme);
    groups.set(key, group);
  });

  const paired: Array<{ theme: ThemeDefinition; order: number }> = [];
  for (const [key, group] of groups) {
    // Ambiguity (two darks for one light) is not guessed at, and a pair
    // whose stripped name collides with a built-in id ("Grove Light" +
    // "Grove Dark" -> the reserved "grove") stays two single themes rather
    // than failing the whole batch.
    if (group.light.length === 1 && group.dark.length === 1) {
      try {
        paired.push({
          order: group.order,
          theme: parseThemeFile({
            version: THEME_FILE_VERSION,
            ...(options?.pairedId ? { id: options.pairedId(group.light[0]!, group.dark[0]!) } : {}),
            name: key,
            appearance: "light",
            colors: group.light[0]!.colors,
            variants: { dark: group.dark[0]!.colors },
          }),
        });
        continue;
      } catch {
        // Fall through to the individual themes below.
      }
    }
    for (const theme of [...group.light, ...group.dark]) {
      paired.push({ theme, order: group.order });
    }
  }

  return [...passthrough, ...paired].sort((a, b) => a.order - b.order).map((entry) => entry.theme);
}

/**
 * Some extensions reuse one display name across every file: Dracula ships
 * dracula.json and dracula-soft.json that both say "Dracula". When a batch
 * carries the same id twice, the file names are the only thing that tells
 * the variants apart, so colliding entries are relabelled from their file
 * name (and numbered only when even that collides).
 */
export function resolveThemeLabelCollisions(
  entries: ReadonlyArray<{ theme: ThemeDefinition; sourceName?: string | undefined }>,
): ReadonlyArray<ThemeDefinition> {
  // Null when the new name is unusable (reserved id, invalid characters).
  const rename = (theme: ThemeDefinition, name: string): ThemeDefinition | null => {
    try {
      return parseThemeFile({
        version: THEME_FILE_VERSION,
        name: name.slice(0, 48),
        appearance: theme.appearance,
        colors: theme.colors,
        ...(theme.variants ? { variants: theme.variants } : {}),
        ...(theme.managed ? { managed: true } : {}),
      });
    } catch {
      return null;
    }
  };

  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.theme.id, (counts.get(entry.theme.id) ?? 0) + 1);
  }
  const relabelled = entries.map(({ theme, sourceName }) => {
    if ((counts.get(theme.id) ?? 0) < 2) return theme;
    const stem = sourceName?.replace(/\.[^.]+$/, "");
    const fromFile = stem ? humanizeThemeName(stem) : null;
    const renamed =
      fromFile && fromFile.toLowerCase() !== theme.label.toLowerCase()
        ? rename(theme, fromFile)
        : null;
    return renamed ?? theme;
  });

  const seen = new Set<string>();
  return relabelled.map((theme) => {
    if (!seen.has(theme.id)) {
      seen.add(theme.id);
      return theme;
    }
    for (let suffix = 2; suffix < 100; suffix += 1) {
      const candidate = rename(theme, `${theme.label} ${suffix}`);
      if (candidate && !seen.has(candidate.id)) {
        seen.add(candidate.id);
        return candidate;
      }
    }
    return theme;
  });
}
