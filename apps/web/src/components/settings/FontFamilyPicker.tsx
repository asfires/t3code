import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { CheckIcon } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  isFontFamilyAvailable,
  isMonospaceFamily,
  queryInstalledFontFamilies,
} from "../../appearanceFonts";
import {
  canUseHostFontEnumeration,
  loadHostFontFamily,
  queryHostFontFamilies,
} from "../../hostFonts";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxItem,
  ComboboxListVirtualized,
  ComboboxPopup,
  ComboboxTrigger,
} from "../ui/combobox";
import { SelectButton } from "../ui/select";

const DEFAULT_FONT_VALUE = "__default__";

function supportsFontEnumeration(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as { queryLocalFonts?: unknown }).queryLocalFonts === "function"
  );
}

type FontEnumerationState =
  | { readonly status: "unknown"; readonly isLoading: boolean }
  | {
      readonly status: "granted";
      readonly families: readonly string[];
      readonly isLoading: boolean;
    }
  | { readonly status: "denied" | "unsupported"; readonly isLoading: boolean };

// Shared across every row: once one picker learns the fonts (or learns the
// permission is blocked), the others follow without re-querying.
let enumerationState: FontEnumerationState =
  supportsFontEnumeration() || canUseHostFontEnumeration()
    ? { status: "unknown", isLoading: false }
    : { status: "unsupported", isLoading: false };
const enumerationListeners = new Set<() => void>();

function subscribeToEnumeration(listener: () => void): () => void {
  enumerationListeners.add(listener);
  return () => enumerationListeners.delete(listener);
}

function readEnumerationState(): FontEnumerationState {
  return enumerationState;
}

let enumerationLoad: Promise<void> | null = null;

function publishEnumerationState(state: FontEnumerationState): void {
  enumerationState = state;
  for (const listener of enumerationListeners) listener();
}

/** Query live host fonts locally, falling back to browser enumeration remotely. */
export function discoverInstalledFonts(options?: {
  readonly refresh?: boolean;
  readonly hostOnly?: boolean;
}): Promise<void> {
  const refresh = options?.refresh === true;
  if (enumerationLoad !== null) return enumerationLoad;
  if (!refresh && enumerationState.status !== "unknown") return Promise.resolve();

  publishEnumerationState({ ...enumerationState, isLoading: true });
  const load = (async () => {
    const hostFamilies = await queryHostFontFamilies();
    if (hostFamilies !== null) {
      return { families: hostFamilies, status: "granted" } as const;
    }
    if (options?.hostOnly) return null;
    return queryInstalledFontFamilies({ refresh });
  })().then((result) => {
    enumerationLoad = null;
    if (result === null) {
      publishEnumerationState({ status: "unknown", isLoading: false });
      return;
    }
    publishEnumerationState(
      result.status === "granted"
        ? { status: "granted", families: result.families, isLoading: false }
        : { status: result.status, isLoading: false },
    );
  });
  enumerationLoad = load;
  return load;
}

let grantedProbeStarted = false;

/**
 * Discover host fonts eagerly for a local T3 instance. Remote web clients use
 * browser-local enumeration instead, and query eagerly only when that browser
 * permission was already granted.
 */
function probeAlreadyGrantedPermission(): void {
  if (grantedProbeStarted || enumerationState.status !== "unknown") return;
  grantedProbeStarted = true;
  if (canUseHostFontEnumeration()) {
    void discoverInstalledFonts({ refresh: true, hostOnly: true });
    return;
  }
  const permissions = typeof navigator !== "undefined" ? navigator.permissions : undefined;
  if (typeof permissions?.query !== "function") return;
  permissions.query({ name: "local-fonts" as PermissionName }).then(
    (status) => {
      if (status.state === "granted") void discoverInstalledFonts();
    },
    () => {
      // The engine does not recognize the permission name; keep the
      // focus-driven flow.
    },
  );
}

/**
 * Whether the engine can list installed fonts (Local Font Access API —
 * Chromium and Electron). "unknown" until discovery resolves the permission.
 * The picker remains usable for exact-name entry in denied and unsupported
 * environments; only browsing the complete installed list depends on this
 * state. Where permission is already granted, discovery starts at mount.
 */
function useFontEnumeration(): FontEnumerationState {
  useEffect(probeAlreadyGrantedPermission, []);
  return useSyncExternalStore(subscribeToEnumeration, readEnumerationState);
}

export function FontFamilyPicker({
  ariaLabel,
  defaultFamily,
  selectedFamily,
  requireMonospace = false,
  initialOpen = false,
  onSelect,
}: {
  ariaLabel: string;
  defaultFamily: string;
  selectedFamily: string;
  requireMonospace?: boolean;
  initialOpen?: boolean;
  onSelect: (family: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Open after mount rather than mounting open: a popup that first renders in
  // its open state never receives Base UI's entrance style baseline, so the
  // exit transition on close has no style delta, never fires transitionend,
  // and the popup lingers on screen forever.
  const [openAfterMount] = useState(initialOpen);
  useEffect(() => {
    if (openAfterMount) {
      // oxlint-disable-next-line react/set-state-in-effect -- Base UI needs one closed commit first to record the popup's entrance style.
      setOpen(true);
      void discoverInstalledFonts({ refresh: true });
    }
  }, [openAfterMount]);
  const listRef = useRef<LegendListRef | null>(null);
  const enumeration = useFontEnumeration();

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setQuery("");
      void discoverInstalledFonts({ refresh: true });
    }
  };

  const families =
    enumeration.status !== "granted"
      ? []
      : requireMonospace
        ? enumeration.families.filter(isMonospaceFamily)
        : enumeration.families;

  const manualFamily = (() => {
    const candidate = query.trim();
    if (candidate.length === 0) return null;
    if (
      families.some(
        (family) => family.localeCompare(candidate, undefined, { sensitivity: "accent" }) === 0,
      )
    )
      return null;
    if (!isFontFamilyAvailable(candidate)) return null;
    if (requireMonospace && !isMonospaceFamily(candidate)) return null;
    return candidate;
  })();

  const items = (() => {
    const trimmedQuery = query.trim().toLowerCase();
    const result: string[] = [];
    if (trimmedQuery.length === 0) result.push(DEFAULT_FONT_VALUE);
    if (manualFamily !== null) result.push(manualFamily);
    result.push(
      ...families.filter(
        (family) => trimmedQuery.length === 0 || family.toLowerCase().includes(trimmedQuery),
      ),
    );
    return result;
  })();

  const selectedValue = selectedFamily.length === 0 ? DEFAULT_FONT_VALUE : selectedFamily;

  const handlePick = (value: string) => {
    setOpen(false);
    if (value !== DEFAULT_FONT_VALUE) void loadHostFontFamily(value);
    onSelect(value === DEFAULT_FONT_VALUE ? "" : value);
  };

  const renderItem = (item: string, index: number) => {
    const isDefault = item === DEFAULT_FONT_VALUE;
    const isManual = item === manualFamily;
    const family = isDefault ? defaultFamily : item;
    return (
      <ComboboxItem hideIndicator index={index} key={item} value={item}>
        <div className="flex w-full min-w-0 items-center justify-between gap-2">
          <span className="min-w-0 truncate" style={{ fontFamily: family }}>
            {family}
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {isDefault ? <span className="text-3xs text-muted-foreground/60">default</span> : null}
            {isManual ? (
              <span className="text-3xs text-muted-foreground/60">use exact name</span>
            ) : null}
            {item === selectedValue ? (
              <CheckIcon className="size-3.5 text-muted-foreground" />
            ) : null}
          </span>
        </div>
      </ComboboxItem>
    );
  };

  return (
    <Combobox
      items={items}
      filteredItems={items}
      autoHighlight
      virtualized
      open={open}
      onOpenChange={handleOpenChange}
      value={selectedValue}
      onValueChange={(next) => {
        if (typeof next === "string") handlePick(next);
      }}
      onItemHighlighted={(_value, eventDetails) => {
        if (!open || eventDetails.index < 0 || eventDetails.reason !== "keyboard") return;
        void listRef.current?.scrollIndexIntoView?.({ index: eventDetails.index, animated: false });
      }}
    >
      <ComboboxTrigger aria-label={ariaLabel} render={<SelectButton size="sm" />}>
        {selectedFamily.length === 0 ? defaultFamily : selectedFamily}
      </ComboboxTrigger>
      <ComboboxPopup align="end" className="flex w-72 flex-col">
        <ComboboxSearchInput
          placeholder="Search or enter a font…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {enumeration.status !== "granted" ? (
          <p className="px-3 pt-1.5 text-3xs leading-snug text-muted-foreground/70">
            {enumeration.status === "denied"
              ? "Installed font list access is blocked. Enter an exact family name or update the browser permission."
              : enumeration.status === "unsupported"
                ? "This browser cannot list installed fonts. Enter an exact family name."
                : enumeration.isLoading
                  ? "Loading installed fonts…"
                  : "Open the picker to load installed fonts, or enter an exact family name."}
          </p>
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <ComboboxEmpty>No fonts found.</ComboboxEmpty>
          <div className="relative min-h-0 max-h-72 w-full flex-1 overflow-hidden">
            <ComboboxListVirtualized>
              <LegendList<string>
                ref={listRef}
                data={items}
                // Rows are memoized by item, but Base UI highlights and selects
                // virtualized rows by index. Re-render them when filtering moves
                // a surviving item to a new index.
                extraData={items}
                keyExtractor={(item) => item}
                renderItem={({ item, index }) => renderItem(item, index)}
                estimatedItemSize={30}
                drawDistance={360}
                style={{ height: Math.min(items.length * 30, 288) }}
              />
            </ComboboxListVirtualized>
          </div>
        </div>
      </ComboboxPopup>
    </Combobox>
  );
}
