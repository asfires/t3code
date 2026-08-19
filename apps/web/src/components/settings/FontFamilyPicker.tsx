import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
  ComboboxInput,
  ComboboxItem,
  ComboboxListVirtualized,
  ComboboxPopup,
  ComboboxTrigger,
} from "../ui/combobox";

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
export function useFontEnumeration(): FontEnumerationState {
  useEffect(probeAlreadyGrantedPermission, []);
  return useSyncExternalStore(subscribeToEnumeration, readEnumerationState);
}

/**
 * A searchable picker over every installed family, the way native editors
 * list system fonts. The trigger always names the font in use: the committed
 * family, or what the default stack resolves to on this machine.
 */
export function FontFamilyPicker({
  ariaLabel,
  defaultFamily,
  selectedFamily,
  requireMonospace = false,
  onSelect,
}: {
  ariaLabel: string;
  /** What an unset preference renders as, e.g. "Menlo". */
  defaultFamily: string;
  /** Committed family name; empty string means the default is in use. */
  selectedFamily: string;
  requireMonospace?: boolean;
  onSelect: (family: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const listRef = useRef<LegendListRef | null>(null);
  const enumeration = useFontEnumeration();

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setQuery("");
      // Host enumeration is deliberately uncached so installing a font while
      // T3 is open is reflected the next time any picker opens.
      void discoverInstalledFonts({ refresh: true });
    }
  };

  const families = useMemo(() => {
    if (enumeration.status !== "granted") return [];
    return requireMonospace ? enumeration.families.filter(isMonospaceFamily) : enumeration.families;
  }, [enumeration, requireMonospace]);

  const manualFamily = useMemo(() => {
    const candidate = query.trim();
    if (candidate.length === 0) return null;
    if (
      families.some(
        (family) => family.localeCompare(candidate, undefined, { sensitivity: "accent" }) === 0,
      )
    ) {
      return null;
    }
    if (!isFontFamilyAvailable(candidate)) return null;
    if (requireMonospace && !isMonospaceFamily(candidate)) return null;
    return candidate;
  }, [families, query, requireMonospace]);

  const collectionItems = useMemo(() => {
    const result = [DEFAULT_FONT_VALUE];
    if (manualFamily !== null) result.push(manualFamily);
    result.push(...families);
    return result;
  }, [families, manualFamily]);

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const result: string[] = [];
    if (normalizedQuery.length === 0) result.push(DEFAULT_FONT_VALUE);
    if (manualFamily !== null) result.push(manualFamily);
    result.push(
      ...families.filter(
        (family) => normalizedQuery.length === 0 || family.toLowerCase().includes(normalizedQuery),
      ),
    );
    return result;
  }, [families, manualFamily, query]);

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
            {isDefault ? (
              <span className="text-[10px] text-muted-foreground/60">default</span>
            ) : null}
            {isManual ? (
              <span className="text-[10px] text-muted-foreground/60">use exact name</span>
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
      items={collectionItems}
      filteredItems={filteredItems}
      autoHighlight
      virtualized
      open={open}
      onOpenChange={handleOpenChange}
      value={selectedValue}
      onValueChange={(next) => {
        if (typeof next === "string") handlePick(next);
      }}
      onItemHighlighted={(_value, eventDetails) => {
        // Keyboard highlights must pull the virtualized row into view, or
        // arrow keys walk past the rendered window and navigate blind.
        if (!open || eventDetails.index < 0 || eventDetails.reason !== "keyboard") return;
        void listRef.current?.scrollIndexIntoView?.({ index: eventDetails.index, animated: false });
      }}
    >
      <ComboboxTrigger
        aria-label={ariaLabel}
        className="relative inline-flex min-h-9 w-full min-w-36 cursor-pointer select-none items-center justify-between gap-2 rounded-lg border border-input bg-background px-[calc(--spacing(3)-1px)] text-left text-base text-foreground shadow-xs/5 outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24 sm:min-h-8 sm:text-sm dark:bg-input/32"
      >
        <span className="min-w-0 truncate">
          {selectedFamily.length === 0 ? defaultFamily : selectedFamily}
        </span>
        <ChevronDownIcon className="-me-1 size-3 shrink-0 text-muted-foreground opacity-50" />
      </ComboboxTrigger>
      <ComboboxPopup align="end" className="flex w-72 flex-col">
        <div className="shrink-0 px-3 pt-2.5">
          <div className="relative -translate-y-px border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-muted-foreground/55"
            />
            <ComboboxInput
              className="[&_input]:h-6.5 [&_input]:ps-5 [&_input]:font-sans [&_input]:leading-6.5"
              inputClassName="rounded-none bg-transparent text-sm"
              placeholder="Search or enter a font…"
              showTrigger={false}
              size="sm"
              unstyled
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {enumeration.status !== "granted" ? (
            <p className="pt-1.5 text-[10px] leading-snug text-muted-foreground/70">
              {enumeration.status === "denied"
                ? "Installed font list access is blocked. Enter an exact family name or update the browser permission."
                : enumeration.status === "unsupported"
                  ? "This browser cannot list installed fonts. Enter an exact family name."
                  : enumeration.isLoading
                    ? "Loading installed fonts…"
                    : "Open the picker to load installed fonts, or enter an exact family name."}
            </p>
          ) : null}
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <ComboboxEmpty>No fonts found.</ComboboxEmpty>
          <div className="relative min-h-0 max-h-72 w-full flex-1 overflow-hidden">
            <ComboboxListVirtualized className="size-full min-w-0 p-0">
              <LegendList<string>
                ref={listRef}
                data={filteredItems}
                // LegendList only re-renders a row when its item or extraData
                // changes, so a font that stays visible while the filter shifts
                // its position would keep a stale `index`. Base UI highlights and
                // Enter-selects by index, so every filter change must re-render.
                extraData={filteredItems}
                keyExtractor={(item) => item}
                renderItem={({ item, index }) => renderItem(item, index)}
                estimatedItemSize={30}
                drawDistance={360}
                style={{ height: Math.min(filteredItems.length * 30, 288) }}
              />
            </ComboboxListVirtualized>
          </div>
        </div>
      </ComboboxPopup>
    </Combobox>
  );
}
