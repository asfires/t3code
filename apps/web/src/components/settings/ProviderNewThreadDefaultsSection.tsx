"use client";

import {
  DEFAULT_RUNTIME_MODE,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionSelection,
  type RuntimeMode,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { Badge } from "../ui/badge";
import { RUNTIME_MODE_CONFIG, RUNTIME_MODE_OPTIONS } from "../chat/runtimeModeConfig";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { resolveNewThreadDefaultModelForInstance } from "./ProviderSettingsPanel.logic";
import { SettingResetButton } from "./settingsLayout";

export interface ProviderNewThreadDefaultsValue {
  readonly modelOptions?: ReadonlyArray<ProviderOptionSelection> | undefined;
  readonly runtimeMode?: RuntimeMode | undefined;
}

function AppDefaultBadge() {
  return (
    <Badge
      variant="outline"
      className="inline-flex h-4 w-fit min-w-0 items-center justify-center gap-0 border-border/70 bg-muted/60 px-1.5 py-0 font-semibold text-[10px] text-muted-foreground leading-none sm:h-4"
    >
      Default
    </Badge>
  );
}

function RuntimeModeValue({ mode }: { readonly mode: RuntimeMode }) {
  const option = RUNTIME_MODE_CONFIG[mode];
  const Icon = option.icon;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon className="size-3.5 text-muted-foreground" />
      {option.label}
    </span>
  );
}

interface ProviderNewThreadDefaultsSectionProps {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string;
  readonly driverKind: ProviderDriverKind | null;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly newThreadDefaults: ProviderNewThreadDefaultsValue | undefined;
  readonly newThreadModel: ModelSelection | null;
  readonly onNewThreadDefaultsChange: (next: ProviderNewThreadDefaultsValue) => void;
}

export function ProviderNewThreadDefaultsSection({
  instanceId,
  displayName,
  driverKind,
  models,
  newThreadDefaults,
  newThreadModel,
  onNewThreadDefaultsChange,
}: ProviderNewThreadDefaultsSectionProps) {
  const representativeModelSlug = resolveNewThreadDefaultModelForInstance({
    instanceId,
    configuredModel: newThreadModel,
    models,
  });
  const representativeModel = models.find((model) => model.slug === representativeModelSlug);
  const descriptors = representativeModel?.capabilities?.optionDescriptors ?? [];
  const hasConfigurableTraits = descriptors.length > 0 && driverKind !== null;
  const hasPinnedDefaults =
    (newThreadDefaults?.modelOptions?.length ?? 0) > 0 ||
    newThreadDefaults?.runtimeMode !== undefined;
  const runtimeMode = newThreadDefaults?.runtimeMode ?? DEFAULT_RUNTIME_MODE;

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-medium text-foreground">New thread defaults</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Applied whenever a new thread selects this provider.
          </p>
        </div>
        {hasPinnedDefaults ? (
          <SettingResetButton
            label={`${displayName} new thread defaults`}
            onClick={() => onNewThreadDefaultsChange({})}
          />
        ) : null}
      </div>

      <div className="mt-3 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
          <span className="text-xs text-muted-foreground">Traits</span>
          {hasConfigurableTraits && representativeModelSlug && driverKind ? (
            <div className="flex flex-wrap items-center justify-end gap-1.5">
              <TraitsPicker
                provider={driverKind}
                models={models}
                model={representativeModelSlug}
                prompt=""
                onPromptChange={() => {}}
                modelOptions={newThreadDefaults?.modelOptions ?? []}
                allowPromptInjectedEffort={false}
                triggerVariant="outline"
                triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                onModelOptionsChange={(nextOptions) => {
                  // The picker reports the complete option set it displays;
                  // store it verbatim so the row is what-you-see-is-what-you-get.
                  onNewThreadDefaultsChange({
                    ...(nextOptions && nextOptions.length > 0 ? { modelOptions: nextOptions } : {}),
                    ...(newThreadDefaults?.runtimeMode
                      ? { runtimeMode: newThreadDefaults.runtimeMode }
                      : {}),
                  });
                }}
              />
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">
              No configurable traits for this provider
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
          <span className="text-xs text-muted-foreground">Permission mode</span>
          <Select
            value={runtimeMode}
            onValueChange={(value) => {
              onNewThreadDefaultsChange({
                ...(newThreadDefaults?.modelOptions
                  ? { modelOptions: newThreadDefaults.modelOptions }
                  : {}),
                runtimeMode: value as RuntimeMode,
              });
            }}
          >
            <SelectTrigger className="w-auto" aria-label={`${displayName} permission mode`}>
              <SelectValue>
                <RuntimeModeValue mode={runtimeMode} />
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {RUNTIME_MODE_OPTIONS.map((mode) => {
                const option = RUNTIME_MODE_CONFIG[mode];
                const OptionIcon = option.icon;
                return (
                  <SelectItem key={mode} value={mode} hideIndicator className="min-w-64 py-2">
                    <div className="grid min-w-0 gap-0.5">
                      <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                        <OptionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        {option.label}
                        {mode === DEFAULT_RUNTIME_MODE ? <AppDefaultBadge /> : null}
                      </span>
                      <span className="text-muted-foreground text-xs leading-4">
                        {option.description}
                      </span>
                    </div>
                  </SelectItem>
                );
              })}
            </SelectPopup>
          </Select>
        </div>
      </div>
    </div>
  );
}
