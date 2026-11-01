import { Check, ChevronDown, Cpu, FileText, FileUp, Globe2, Layers, Settings2, Trash2, Plus, Pencil } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Badge } from "./ui/badge";
import { Banner } from "./patterns/banner";
import { Button } from "./ui/button";
import { Card, CardBody, CardHeader } from "./ui/card";
import { Dialog } from "./ui/dialog";
import { CardActions } from "./ui/inline";
import { Textarea } from "./ui/input";
import { Select } from "./ui/select";
import { Stack } from "./ui/stack";
import { ErrorState, LoadingState } from "./ui/state";
import { Switch } from "./ui/switch";
import { ProviderIcon } from "./ProviderIcon";
import { useProviderModels, useProviders } from "../hooks/providers";
import { useModelAliases, useModelCombos } from "../hooks/routing";
import { useSystemPrompt, useUpdateSystemPrompt } from "../hooks/system-prompt";
import { mergeBuiltinPresets } from "../data/builtin-prompts";
import { toast } from "../lib/toast";
import { getErrorMessage } from "../data/api";
import { isWrappedInjectionProvider } from "../../../src/console/system-prompt/contracts";
import type { PromptSetting, ScopePromptRef, SystemPromptPreset, TenantSystemPrompts } from "../../../src/console/system-prompt/contracts";
import type { ProviderResponse } from "../data/contracts";

const EMPTY_STATE: TenantSystemPrompts = {
  global: null,
  presets: {},
  providers: {},
  models: {},
  combos: {},
  aliases: {},
};
export { EMPTY_STATE };

function modelKey(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

const MODE_OPTIONS = [
  { value: "append", label: "Append" },
  { value: "override", label: "Override" },
] as const;

/** Accepted import formats: raw text (.txt) and structured prompt files (.json). */
const IMPORT_ACCEPT = ".txt,.json,text/plain,application/json";

function enabledSetting(text: string, mode: PromptSetting["mode"]): PromptSetting {
  return { enabled: true, mode, text };
}

function globalRef(): ScopePromptRef {
  return { kind: "global" };
}

function customRef(setting: PromptSetting): ScopePromptRef {
  return { kind: "custom", setting };
}

function presetRef(presetId: string): ScopePromptRef {
  return { kind: "preset", presetId };
}

export { globalRef, customRef, presetRef, enabledSetting };

/** A searchable select (combobox) for option lists that get long. */
function SearchableSelect({
  id,
  label,
  value,
  options,
  placeholder = "Select…",
  onValueChange,
}: {
  readonly id: string;
  readonly label?: string;
  readonly value: string;
  readonly options: readonly { value: string; label: string }[];
  readonly placeholder?: string;
  readonly onValueChange: (value: string) => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);
  const normalizedQuery = query.trim().toLowerCase();
  const filtered =
    normalizedQuery === ""
      ? options
      : options.filter((option) => option.label.toLowerCase().includes(normalizedQuery));

  useEffect(() => {
    if (!open) return;
    const onDocPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onDocKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    document.addEventListener("keydown", onDocKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onDocPointerDown);
      document.removeEventListener("keydown", onDocKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      {label ? (
        <label htmlFor={id} className="form-label mb-3 flex items-center justify-between text-caption font-semibold text-text-primary">
          <span>{label}</span>
        </label>
      ) : null}
      <button
        type="button"
        id={id}
        className="radix-select-trigger inline-flex h-18 w-full items-center justify-between gap-4 rounded-control border border-inner-border bg-surface-2 px-6 text-body font-sans text-text-primary text-left cursor-pointer transition-[border-color,background-color] duration-150 ease-spring hover:border-border-strong focus-visible:outline-2 focus-visible:outline-focus-ring focus-visible:outline-offset-1"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="truncate">{selected?.label ?? placeholder}</span>
        <ChevronDown size={14} className="shrink-0 text-text-tertiary" aria-hidden="true" />
      </button>
      {open ? (
        <div className="absolute z-toast mt-2 w-full overflow-hidden rounded-card border border-border-strong bg-popover-bg p-2.5 shadow-popout backdrop-blur-xl box-border">
          <input
            autoFocus
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search…"
            aria-label="Search"
            className="form-input mb-2 w-full rounded-control border border-inner-border bg-surface-2 px-5 py-3 text-body text-text-primary outline-none transition-[border-color,box-shadow] duration-(--dur-micro) ease-spring focus:border-accent focus:shadow-focus"
          />
          <ul role="listbox" className="max-h-112 overflow-y-auto">
            {filtered.length === 0 ? (
              <li className="px-5 py-4 text-badge text-text-tertiary">No matching options</li>
            ) : (
              filtered.map((option) => (
                <li
                  key={option.value}
                  role="option"
                  aria-selected={option.value === value}
                  className="flex cursor-pointer items-center justify-between gap-4 rounded-control px-5 py-4 text-caption font-medium text-text-primary transition-colors duration-150 select-none hover:bg-surface-hover"
                  onClick={() => {
                    onValueChange(option.value);
                    setOpen(false);
                    setQuery("");
                  }}
                >
                  <span className="truncate">{option.label}</span>
                  {option.value === value ? (
                    <Check size={14} className="shrink-0 text-accent" />
                  ) : null}
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** Shared editor body for one scope: mode selector, prompt textarea, import. */
function PromptEditor({
  id,
  value,
  onChange,
  rows = 4,
}: {
  readonly id: string;
  readonly value: PromptSetting;
  readonly onChange: (next: PromptSetting) => void;
  readonly rows?: number;
}): ReactNode {
  const fileRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const onImport = async (file: File | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      onChange({ ...value, text, enabled: true });
      setImportError(null);
    } catch {
      setImportError("Could not read that file.");
    }
  };
  return (
    <div className="mt-3">
      <div className="mb-3 flex items-center gap-3">
        <Select
          aria-label="Injection mode"
          value={value.mode}
          onValueChange={(next) => onChange({ ...value, mode: next as PromptSetting["mode"] })}
          options={MODE_OPTIONS}
          size="sm"
        />
        <span className="ml-auto text-badge tabular-nums text-text-tertiary">
          {value.text.length.toLocaleString()} chars · 5 MB cap
        </span>
      </div>
      <Textarea
        id={id}
        rows={rows}
        value={value.text}
        onChange={(event) => onChange({ ...value, text: event.target.value })}
        placeholder="Injected system prompt…"
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          icon={<FileUp size={13} />}
          onClick={() => fileRef.current?.click()}
        >
          Import .txt/.json
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept={IMPORT_ACCEPT}
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(event) => {
            void onImport(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        {importError ? (
          <p className="text-badge text-red" role="alert">
            {importError}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The per-scope "source" selector: Global, a named preset, or Custom. Renders
 * a dropdown of available sources plus (when Custom) the prompt editor. For the
 * global scope itself, "Global" is meaningless (self-reference), so
 * `includeGlobalSource` is turned off and an explicit "Off" entry is offered.
 */
export function ScopeSourcePicker({
  id,
  ref,
  presets,
  onChange,
  rows = 5,
  includeGlobalSource = true,
  allowOff = false,
}: {
  readonly id: string;
  readonly ref: ScopePromptRef;
  readonly presets: Readonly<Record<string, SystemPromptPreset>>;
  readonly onChange: (next: ScopePromptRef) => void;
  readonly rows?: number;
  readonly includeGlobalSource?: boolean;
  readonly allowOff?: boolean;
}): ReactNode {
  const presetList = Object.values(presets);
  const sourceOptions: { value: string; label: string }[] = [
    ...(allowOff ? [{ value: "off", label: "Off" }] : []),
    ...(includeGlobalSource ? [{ value: "global", label: "Global" }] : []),
    ...presetList.map((preset) => ({ value: `preset:${preset.id}`, label: `Preset · ${preset.name}` })),
    { value: "custom", label: "Custom" },
  ];
  const currentKind = ref.kind;
  const currentValue =
    currentKind === "preset" ? `preset:${ref.presetId}` : currentKind === "custom" ? "custom" : currentKind === "off" ? "off" : "global";

  const onSourceChange = (next: string) => {
    if (next === "off") onChange({ kind: "off" });
    else if (next === "global") onChange(globalRef());
    else if (next === "custom") onChange(customRef({ enabled: true, mode: "append", text: "" }));
    else {
      const presetId = next.slice("preset:".length);
      onChange(presetRef(presetId));
    }
  };

  return (
    <div className="mt-3">
      <SearchableSelect
        id={id}
        label="Source"
        value={currentValue}
        options={sourceOptions}
        placeholder="Select source…"
        onValueChange={onSourceChange}
      />
      {currentKind === "custom" ? (
        <PromptEditor
          id={`${id}-prompt`}
          value={ref.kind === "custom" ? ref.setting : { enabled: true, mode: "append", text: "" }}
          onChange={(next) => onChange(customRef(next))}
          rows={rows}
        />
      ) : null}
    </div>
  );
}

/** Global scope row: source (preset/custom/off), toggle, explicit clear. */
function GlobalScopeSection({
  value,
  presets,
  onChange,
}: {
  readonly value: ScopePromptRef | null;
  readonly presets: Readonly<Record<string, SystemPromptPreset>>;
  readonly onChange: (next: ScopePromptRef | null) => void;
}): ReactNode {
  const ref = value ?? { kind: "off" as const };
  const isOff = ref.kind === "off";
  const isCustomOn = ref.kind === "custom" && ref.setting.enabled;
  const isPresetOn = ref.kind === "preset" && presets[ref.presetId]?.enabled === true;
  const active = isCustomOn || isPresetOn;
  return (
    <div className="rounded-control border border-inner-border bg-surface-2 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <p className="text-body font-semibold">Global injection</p>
            <Badge tone={active ? "ok" : "default"} dot>
              {active ? "Active" : "Off"}
            </Badge>
          </div>
          <p className="mt-1 text-badge leading-normal text-text-tertiary">
            Applied to every request regardless of provider, model, combo, or alias. Choose a preset or a
            custom prompt; turn it off to stop global injection.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {value !== null ? (
            <Button
              variant="secondary"
              size="sm"
              icon={<Trash2 size={13} />}
              onClick={() => onChange(null)}
              aria-label="Clear global prompt"
            >
              Clear
            </Button>
          ) : null}
          <Switch
            id="isp-global"
            checked={active}
            onChange={(next) =>
              onChange(
                next
                  ? value && value.kind !== "off"
                    ? value
                    : customRef(enabledSetting("", "append"))
                  : { kind: "off" },
              )
            }
            aria-label="Enable global injection"
            className="shrink-0"
          />
        </div>
      </div>
      {!isOff ? (
        <ScopeSourcePicker
          id="isp-global-source"
          ref={ref}
          presets={presets}
          onChange={onChange}
          includeGlobalSource={false}
          allowOff
        />
      ) : null}
    </div>
  );
}

/** Preset management section: cards + create/edit/delete. */
function PresetSection({
  presets,
  onChange,
}: {
  readonly presets: Readonly<Record<string, SystemPromptPreset>>;
  readonly onChange: (next: Readonly<Record<string, SystemPromptPreset>>) => void;
}): ReactNode {
  const [editing, setEditing] = useState<SystemPromptPreset | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<SystemPromptPreset | null>(null);

  const upsert = (draft: SystemPromptPreset) => {
    onChange({ ...presets, [draft.id]: draft });
  };
  const remove = (id: string) => {
    const next = { ...presets };
    delete next[id];
    onChange(next);
  };

  const list = Object.values(presets);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-body font-semibold">Presets</p>
          <p className="text-badge leading-normal text-text-tertiary">
            Reusable prompts any scope can reference — global, provider, model, combo, or alias.
          </p>
        </div>
        <Button variant="secondary" size="sm" icon={<Plus size={14} />} onClick={() => setCreating(true)}>
          New preset
        </Button>
      </div>
      {list.length === 0 ? (
        <p className="rounded-control border border-dashed border-inner-border px-4 py-6 text-center text-badge text-text-tertiary">
          No presets yet — create one to reuse across scopes.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-4 max-medium:grid-cols-1">
          {list.map((preset) => (
            <div key={preset.id} className="rounded-control border border-inner-border bg-surface-2 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-caption font-semibold text-text-primary">{preset.name}</p>
                    <Badge tone={preset.enabled ? "ok" : "default"} dot>
                      {preset.enabled ? "Active" : "Off"}
                    </Badge>
                  </div>
                  <p className="mt-1 text-badge text-text-tertiary">
                    {preset.mode === "override" ? "Override" : "Append"} · {preset.text.length.toLocaleString()} chars
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Switch
                    id={`isp-preset-${preset.id}-enabled`}
                    checked={preset.enabled}
                    onChange={(next) => upsert({ ...preset, enabled: next })}
                    aria-label={`Toggle preset ${preset.name}`}
                  />
                  <Button variant="ghost" size="icon" icon={<Pencil size={14} />} aria-label={`Edit preset ${preset.name}`} onClick={() => setEditing(preset)} />
                  <Button variant="ghost" size="icon" icon={<Trash2 size={14} />} aria-label={`Delete preset ${preset.name}`} onClick={() => setConfirmDelete(preset)} />
                </div>
              </div>
              <p className="mt-2 line-clamp-2 whitespace-pre-wrap break-words text-badge leading-normal text-text-secondary">
                {preset.text}
              </p>
            </div>
          ))}
        </div>
      )}

      {(creating || editing !== null) ? (
        <PresetEditorDialog
          preset={editing ?? { id: crypto.randomUUID(), name: "", enabled: true, mode: "append", text: "" }}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSave={(draft) => {
            upsert(draft);
            setCreating(false);
            setEditing(null);
          }}
        />
      ) : null}

      {confirmDelete !== null ? (
        <Dialog
          open
          onClose={() => setConfirmDelete(null)}
          title={`Delete preset “${confirmDelete.name}”?`}
          size="sm"
          footer={
            <>
              <Button variant="secondary" onClick={() => setConfirmDelete(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  remove(confirmDelete.id);
                  setConfirmDelete(null);
                }}
              >
                Delete
              </Button>
            </>
          }
        >
          <p className="text-body text-text-secondary">
            Scopes referencing this preset will fall back to Global. This cannot be undone.
          </p>
        </Dialog>
      ) : null}
    </div>
  );
}

function PresetEditorDialog({
  preset,
  onClose,
  onSave,
}: {
  readonly preset: SystemPromptPreset;
  readonly onClose: () => void;
  readonly onSave: (next: SystemPromptPreset) => void;
}): ReactNode {
  const [name, setName] = useState(preset.name);
  const [mode, setMode] = useState<PromptSetting["mode"]>(preset.mode);
  const [text, setText] = useState(preset.text);
  const [enabled, setEnabled] = useState(preset.enabled);

  return (
    <Dialog
      open
      onClose={onClose}
      title={preset.name ? "Edit preset" : "New preset"}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={name.trim().length === 0}
            onClick={() => onSave({ ...preset, name: name.trim(), mode, text, enabled })}
          >
            Save preset
          </Button>
        </>
      }
    >
      <Stack gap="14px">
        <div>
          <label htmlFor="preset-name" className="form-label mb-2 block text-caption font-semibold text-text-primary">
            Name
          </label>
          <input
            id="preset-name"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Formal tone, Security rules"
            className="form-input w-full rounded-control border border-inner-border bg-surface-2 px-4 py-3 text-body text-text-primary outline-none transition-[border-color,box-shadow] duration-(--dur-micro) ease-spring focus:border-accent focus:shadow-focus"
          />
        </div>
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-body font-semibold">Enabled</p>
            <p className="text-badge leading-normal text-text-tertiary">Disabled presets inject nothing.</p>
          </div>
          <Switch id="preset-enabled" checked={enabled} onChange={setEnabled} aria-label="Enable preset" />
        </div>
        <PromptEditor id="preset-prompt" value={{ enabled, mode, text }} onChange={(next) => { setMode(next.mode); setText(next.text); setEnabled(next.enabled); }} rows={6} />
      </Stack>
    </Dialog>
  );
}

/** One provider card: source selector (global/preset/custom), wrapped badge. */
function ProviderScopeCard({
  provider,
  entry,
  presets,
  onChange,
}: {
  readonly provider: ProviderResponse;
  readonly entry: ScopePromptRef | undefined;
  readonly presets: Readonly<Record<string, SystemPromptPreset>>;
  readonly onChange: (next: ScopePromptRef | undefined) => void;
}): ReactNode {
  const providerLabel = provider.label ?? provider.displayName;
  const ref = entry ?? globalRef();
  const wrapped = isWrappedInjectionProvider(provider.providerId);

  const customSetting = ref.kind === "custom" ? ref.setting : undefined;
  const customConfigured = ref.kind === "custom";
  const active = ref.kind === "custom" && customSetting?.enabled === true;
  const presetActive = ref.kind === "preset" ? presets[ref.presetId]?.enabled === true : false;
  const isOff = ref.kind === "off";
  const isActive = active || presetActive;

  return (
    <div
      className={`rounded-control border p-5 ${
        isActive ? "border-inner-border bg-green-soft/40" : "border-inner-border bg-surface-2"
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <ProviderIcon icon={provider.providerId} name={provider.displayName} size={28} />
            <div className="min-w-0">
              <p className="truncate text-body font-semibold text-text-primary">{providerLabel}</p>
              <p className="truncate text-badge text-text-tertiary">{provider.providerId}</p>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {isActive ? (
            <Badge tone="ok" dot>
              Active
            </Badge>
          ) : isOff ? (
            <Badge tone="default" dot>
              Off
            </Badge>
          ) : customConfigured ? (
            <Badge tone="warn" dot>
              Custom off
            </Badge>
          ) : ref.kind === "preset" ? (
            <Badge tone="warn" dot>
              Preset off
            </Badge>
          ) : (
            <Badge tone="info" dot>
              Following global
            </Badge>
          )}
          {wrapped ? (
            <Badge tone="info" title="This provider validates its fixed system prompt; your text is appended after it inside gateway markers.">
              Wrapped
            </Badge>
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-badge leading-normal text-text-tertiary">
          {ref.kind === "custom" && customSetting?.enabled ? (
            <span className="line-clamp-2 flex-1 whitespace-pre-wrap break-words text-text-secondary">{customSetting.text}</span>
          ) : ref.kind === "preset" ? (
            <span>Using preset “{presets[ref.presetId]?.name ?? ref.presetId}”.</span>
          ) : ref.kind === "off" ? (
            <span>Injection is off for this provider — nothing is appended.</span>
          ) : (
            <span>Follows the global prompt.</span>
          )}
        </p>
      </div>

      <ScopeSourcePicker
        id={`isp-provider-${provider.providerId}`}
        ref={ref}
        presets={presets}
        onChange={onChange}
        rows={5}
        allowOff
      />
    </div>
  );
}

/** One model card in the per-model grid. */
function ModelScopeRow({
  providerId,
  modelId,
  route,
  value,
  presets,
  onChange,
}: {
  readonly providerId: string;
  readonly modelId: string;
  readonly route: string;
  readonly value: ScopePromptRef | undefined;
  readonly presets: Readonly<Record<string, SystemPromptPreset>>;
  readonly onChange: (next: ScopePromptRef | undefined) => void;
}): ReactNode {
  const ref = value ?? globalRef();
  const key = modelKey(providerId, modelId);

  const customSetting = ref.kind === "custom" ? ref.setting : undefined;
  const active = ref.kind === "custom" && customSetting?.enabled === true;
  const presetActive = ref.kind === "preset" ? presets[ref.presetId]?.enabled === true : false;
  const isOff = ref.kind === "off";
  const isActive = active || presetActive;

  return (
    <div
      className={`rounded-control border p-4 ${
        isActive ? "border-inner-border bg-green-soft/40" : "border-inner-border bg-surface-2"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-caption font-semibold text-text-primary">{modelId}</p>
          <p className="truncate text-badge text-text-tertiary">{route}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isActive ? (
            <Badge tone="ok" dot>
              Active
            </Badge>
          ) : isOff ? (
            <Badge tone="default" dot>
              Off
            </Badge>
          ) : null}
          <Switch
            id={`isp-model-${key}`}
            checked={ref.kind === "custom" && customSetting?.enabled === true}
            onChange={(next) =>
              onChange(
                next
                  ? customRef(enabledSetting(ref.kind === "custom" ? ref.setting.text : "", "append"))
                  : { kind: "off" },
              )
            }
            aria-label={`Enable injection for ${modelId}`}
          />
        </div>
      </div>
      <ScopeSourcePicker id={`isp-model-${key}`} ref={ref} presets={presets} onChange={onChange} rows={3} allowOff />
    </div>
  );
}

/** One combo/alias row. */
function NamedScopeRow({
  name,
  kind,
  value,
  presets,
  onChange,
}: {
  readonly name: string;
  readonly kind: "combo" | "alias";
  readonly value: ScopePromptRef | undefined;
  readonly presets: Readonly<Record<string, SystemPromptPreset>>;
  readonly onChange: (next: ScopePromptRef | undefined) => void;
}): ReactNode {
  const ref = value ?? globalRef();
  const customSetting = ref.kind === "custom" ? ref.setting : undefined;
  const active = ref.kind === "custom" && customSetting?.enabled === true;
  const presetActive = ref.kind === "preset" ? presets[ref.presetId]?.enabled === true : false;
  const isOff = ref.kind === "off";
  const isActive = active || presetActive;

  return (
    <div
      className={`rounded-control border p-4 ${
        isActive ? "border-inner-border bg-green-soft/40" : "border-inner-border bg-surface-2"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="default">{kind === "combo" ? "Combo" : "Alias"}</Badge>
            <p className="truncate text-caption font-semibold text-text-primary">{name}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isActive ? (
            <Badge tone="ok" dot>
              Active
            </Badge>
          ) : isOff ? (
            <Badge tone="default" dot>
              Off
            </Badge>
          ) : null}
          <Switch
            id={`isp-${kind}-${name}`}
            checked={ref.kind === "custom" && customSetting?.enabled === true}
            onChange={(next) =>
              onChange(
                next
                  ? customRef(enabledSetting(ref.kind === "custom" ? ref.setting.text : "", "append"))
                  : { kind: "off" },
              )
            }
            aria-label={`Enable injection for ${kind} ${name}`}
          />
        </div>
      </div>
      <ScopeSourcePicker id={`isp-${kind}-${name}`} ref={ref} presets={presets} onChange={onChange} rows={3} allowOff />
    </div>
  );
}

/**
 * The modal for configuring system-prompt injection at multiple scopes:
 * Presets → Global → Per model → Per provider → Combos & Aliases. Every scope
 * can follow global, reference a named preset, or carry a custom prompt.
 * Persists via `PUT /system-prompt`.
 */
export function InjectSystemPromptDialog({
  open,
  onClose,
  state,
  onSave,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly state: TenantSystemPrompts;
  readonly onSave: (next: TenantSystemPrompts) => void;
}): ReactNode {
  const [draft, setDraft] = useState<TenantSystemPrompts>(() => mergeBuiltinPresets(state));
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) setDraft(mergeBuiltinPresets(state));
    wasOpen.current = open;
  }, [open, state]);

  const providersQuery = useProviders();
  const providerRows = providersQuery.data ?? [];
  const [providerSearch, setProviderSearch] = useState("");
  const query = providerSearch.trim().toLowerCase();
  const filteredProviders =
    query === ""
      ? providerRows
      : providerRows.filter((provider) =>
          `${provider.label ?? provider.displayName} ${provider.providerId}`
            .toLowerCase()
            .includes(query),
        );

  const [modelProviderId, setModelProviderId] = useState("");
  const modelsQuery = useProviderModels(modelProviderId || undefined);
  const modelRows = modelsQuery.data ?? [];

  useEffect(() => {
    if (modelProviderId === "" && providerRows.length > 0) {
      setModelProviderId(providerRows[0]!.providerId);
    }
  }, [providerRows, modelProviderId]);

  const aliasesQuery = useModelAliases();
  const combosQuery = useModelCombos();
  const aliases = aliasesQuery.data ?? [];
  const combos = combosQuery.data ?? [];

  const patchGlobal = (next: ScopePromptRef | null) =>
    setDraft((prev) => ({ ...prev, global: next }));
  const patchPresets = (next: Readonly<Record<string, SystemPromptPreset>>) =>
    setDraft((prev) => ({ ...prev, presets: next }));
  const patchProvider = (providerId: string, next: ScopePromptRef | undefined) =>
    setDraft((prev) => {
      const providers = { ...prev.providers };
      if (next === undefined) delete providers[providerId];
      else providers[providerId] = next;
      return { ...prev, providers };
    });
  const patchModel = (providerId: string, modelId: string, next: ScopePromptRef | undefined) =>
    setDraft((prev) => {
      const models = { ...prev.models };
      const key = modelKey(providerId, modelId);
      if (next === undefined) delete models[key];
      else models[key] = next;
      return { ...prev, models };
    });
  const patchNamed = (kind: "combo" | "alias", name: string, next: ScopePromptRef | undefined) =>
    setDraft((prev) => {
      const map = { ...(kind === "combo" ? prev.combos : prev.aliases) };
      if (next === undefined) delete map[name];
      else map[name] = next;
      return kind === "combo" ? { ...prev, combos: map } : { ...prev, aliases: map };
    });

  const providerOptions = providerRows.map((provider) => ({
    value: provider.providerId,
    label: provider.label ?? provider.displayName,
  }));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Inject System Prompt"
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onSave(draft);
              onClose();
            }}
          >
            Save changes
          </Button>
        </>
      }
    >
      <Stack gap="20px">
        <section>
          <h4 className="flex items-center gap-2.5 text-caption font-semibold text-text-primary">
            <FileText size={14} className="text-text-secondary" aria-hidden="true" />
            Presets
          </h4>
          <p className="mb-3 mt-1 text-badge leading-normal text-text-tertiary">
            Create reusable prompts, then reference them from any scope below.
          </p>
          <PresetSection presets={draft.presets} onChange={patchPresets} />
        </section>

        <section className="border-t border-inner-border pt-6">
          <h4 className="flex items-center gap-2.5 text-caption font-semibold text-text-primary">
            <Globe2 size={14} className="text-text-secondary" aria-hidden="true" />
            Global
          </h4>
          <p className="mb-3 mt-1 text-badge leading-normal text-text-tertiary">
            Applied to every request regardless of provider, model, combo, or alias.
          </p>
          <GlobalScopeSection value={draft.global} presets={draft.presets} onChange={patchGlobal} />
        </section>

        <section className="border-t border-inner-border pt-6">
          <h4 className="flex items-center gap-2.5 text-caption font-semibold text-text-primary">
            <Cpu size={14} className="text-text-secondary" aria-hidden="true" />
            Per model
          </h4>
          <p className="mb-3 mt-1 text-badge leading-normal text-text-tertiary">
            Only that exact model of a provider gets this prompt; it wins over the provider and
            global injections.
          </p>
          <SearchableSelect
            label="Provider"
            id="isp-model-provider"
            value={modelProviderId}
            onValueChange={setModelProviderId}
            options={providerOptions}
            placeholder="Select provider…"
          />
          <div className="mt-3">
            {modelProviderId === "" ? (
              <p className="text-badge leading-normal text-text-tertiary">
                Select a provider to configure per-model injections.
              </p>
            ) : modelsQuery.isPending ? (
              <LoadingState label="Loading models…" />
            ) : modelsQuery.isError ? (
              <ErrorState message="Failed to load models" onRetry={() => void modelsQuery.refetch()} />
            ) : modelRows.length === 0 ? (
              <p className="text-badge leading-normal text-text-tertiary">
                No models configured for this provider.
              </p>
            ) : (
              <>
                {(() => {
                  const activeModels = modelRows.filter(
                    (model) => {
                      const ref = draft.models[modelKey(modelProviderId, model.modelId)];
                      return ref?.kind === "custom"
                        ? ref.setting.enabled
                        : ref?.kind === "preset"
                          ? draft.presets[ref.presetId]?.enabled === true
                          : false;
                    },
                  ).length;
                  return (
                    <p className="mb-3 text-badge leading-normal text-text-tertiary">
                      {activeModels > 0
                        ? `${activeModels} of ${modelRows.length} models active for this provider.`
                        : `${modelRows.length} models — none active yet.`}
                    </p>
                  );
                })()}
                <div className="grid grid-cols-3 gap-4 max-medium:grid-cols-2 max-small:grid-cols-1">
                  {modelRows.map((model) => (
                    <ModelScopeRow
                      key={modelKey(modelProviderId, model.modelId)}
                      providerId={modelProviderId}
                      modelId={model.modelId}
                      route={model.route}
                      value={draft.models[modelKey(modelProviderId, model.modelId)]}
                      presets={draft.presets}
                      onChange={(next) => patchModel(modelProviderId, model.modelId, next)}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        </section>

        <section className="border-t border-inner-border pt-6">
          <h4 className="flex items-center gap-2.5 text-caption font-semibold text-text-primary">
            <Layers size={14} className="text-text-secondary" aria-hidden="true" />
            Per provider
          </h4>
          <p className="mb-3 mt-1 text-badge leading-normal text-text-tertiary">
            Follow the global prompt, reference a preset, or carry a custom one — models under a
            custom provider can still override per-model.
          </p>
          {providersQuery.isPending ? (
            <LoadingState label="Loading providers…" />
          ) : providersQuery.isError ? (
            <ErrorState message="Failed to load providers" onRetry={() => void providersQuery.refetch()} />
          ) : providerRows.length === 0 ? (
            <p className="text-badge leading-normal text-text-tertiary">No providers configured yet.</p>
          ) : (
            <>
              <input
                type="search"
                value={providerSearch}
                onChange={(event) => setProviderSearch(event.target.value)}
                placeholder="Search providers…"
                aria-label="Search providers"
                className="form-input w-full rounded-control border border-inner-border bg-surface-2 px-6 py-4 text-body text-text-primary outline-none transition-[border-color,box-shadow] duration-(--dur-micro) ease-spring focus:border-accent focus:shadow-focus"
              />
              {filteredProviders.length === 0 ? (
                <p className="mt-4 text-badge leading-normal text-text-tertiary">
                  No providers match “{providerSearch.trim()}”.
                </p>
              ) : (
                <div className="mt-4 grid grid-cols-3 gap-4 max-medium:grid-cols-2 max-small:grid-cols-1">
                  {filteredProviders.map((provider) => (
                    <ProviderScopeCard
                      key={provider.providerId}
                      provider={provider}
                      entry={draft.providers[provider.providerId]}
                      presets={draft.presets}
                      onChange={(next) => patchProvider(provider.providerId, next)}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </section>

        <section className="border-t border-inner-border pt-6">
          <h4 className="flex items-center gap-2.5 text-caption font-semibold text-text-primary">
            <Layers size={14} className="text-text-secondary" aria-hidden="true" />
            Combos &amp; Aliases
          </h4>
          <p className="mb-3 mt-1 text-badge leading-normal text-text-tertiary">
            A combo or alias can carry its own injection — global, a preset, or custom — applied
            when a request arrives through that name.
          </p>
          {aliasesQuery.isPending || combosQuery.isPending ? (
            <LoadingState label="Loading combos &amp; aliases…" />
          ) : aliasesQuery.isError || combosQuery.isError ? (
            <ErrorState message="Failed to load combos/aliases" onRetry={() => { void aliasesQuery.refetch(); void combosQuery.refetch(); }} />
          ) : combos.length === 0 && aliases.length === 0 ? (
            <p className="text-badge leading-normal text-text-tertiary">
              No combos or aliases configured — create them in Routing first.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-4 max-medium:grid-cols-1">
              {combos.length > 0 ? (
                <div>
                  <p className="mb-2 text-badge font-semibold text-text-tertiary">Combos</p>
                  <div className="space-y-3">
                    {combos.map((combo) => (
                      <NamedScopeRow
                        key={combo.name}
                        kind="combo"
                        name={combo.name}
                        value={draft.combos[combo.name]}
                        presets={draft.presets}
                        onChange={(next) => patchNamed("combo", combo.name, next)}
                      />
                    ))}
                  </div>
                </div>
              ) : null}
              {aliases.length > 0 ? (
                <div>
                  <p className="mb-2 text-badge font-semibold text-text-tertiary">Aliases</p>
                  <div className="space-y-3">
                    {aliases.map((alias) => (
                      <NamedScopeRow
                        key={alias.alias}
                        kind="alias"
                        name={alias.alias}
                        value={draft.aliases[alias.alias]}
                        presets={draft.presets}
                        onChange={(next) => patchNamed("alias", alias.alias, next)}
                      />
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </section>
      </Stack>
    </Dialog>
  );
}

/**
 * The Overview card for system-prompt injection: status tiles for the scopes
 * and an "Open Settings" button launching the dialog. State persists through
 * `PUT /system-prompt`.
 */
export function InjectSystemPromptPanel(): ReactNode {
  const [open, setOpen] = useState(false);
  const settingsQuery = useSystemPrompt();
  const update = useUpdateSystemPrompt();
  const state = settingsQuery.data ?? EMPTY_STATE;

  const providerCount = Object.values(state.providers).filter(
    (ref) => ref.kind === "custom" && ref.setting.enabled,
  ).length + Object.values(state.providers).filter(
    (ref) => ref.kind === "preset" && state.presets[ref.presetId]?.enabled,
  ).length;
  const modelCount = Object.values(state.models).filter(
    (ref) => ref.kind === "custom" && ref.setting.enabled,
  ).length + Object.values(state.models).filter(
    (ref) => ref.kind === "preset" && state.presets[ref.presetId]?.enabled,
  ).length;
  const namedCount = Object.values(state.combos).filter(
    (ref) => ref.kind === "custom" && ref.setting.enabled,
  ).length + Object.values(state.aliases).filter(
    (ref) => ref.kind === "custom" && ref.setting.enabled,
  ).length + Object.values(state.combos).filter(
    (ref) => ref.kind === "preset" && state.presets[ref.presetId]?.enabled,
  ).length + Object.values(state.aliases).filter(
    (ref) => ref.kind === "preset" && state.presets[ref.presetId]?.enabled,
  ).length;
  const presetCount = Object.values(state.presets).length;

  return (
    <Card>
      <CardHeader
        title="Inject System Prompt"
        subtitle="Append custom system instructions to requests"
        icon={<FileText size={16} />}
        action={
          <CardActions>
            <Button
              variant="secondary"
              size="sm"
              icon={<Settings2 size={13} />}
              onClick={() => setOpen(true)}
            >
              Open Settings
            </Button>
          </CardActions>
        }
      />
      <CardBody>
        <Stack gap="14px">
          <div className="grid grid-cols-3 gap-4 max-medium:grid-cols-1">
            {(() => {
              const globalRefValue = state.global;
              const globalOn =
                globalRefValue !== null &&
                (globalRefValue.kind === "custom"
                  ? globalRefValue.setting.enabled
                  : globalRefValue.kind === "preset"
                    ? state.presets[globalRefValue.presetId]?.enabled === true
                    : false);
              const globalLabel = globalOn
                ? globalRefValue?.kind === "preset"
                  ? `Preset · ${state.presets[globalRefValue.presetId]?.name ?? globalRefValue.presetId}`
                  : globalRefValue?.kind === "custom"
                    ? globalRefValue.setting.mode === "override"
                      ? "Override"
                      : "On"
                    : "On"
                : "Off";
              const Tile = ({
                icon,
                label,
                value,
                active,
              }: {
                readonly icon: ReactNode;
                readonly label: string;
                readonly value: string;
                readonly active: boolean;
              }) => (
                <div
                  className={`flex items-center gap-3 rounded-control border px-4 py-3.5 ${
                    active ? "border-inner-border bg-green-soft" : "border-inner-border bg-surface-2"
                  }`}
                >
                  <span
                    className={`shrink-0 ${active ? "text-green" : "text-text-tertiary"}`}
                    aria-hidden="true"
                  >
                    {icon}
                  </span>
                  <div className="min-w-0">
                    <p className="text-badge text-text-tertiary">{label}</p>
                    <p
                      className={`truncate text-body font-semibold ${
                        active ? "text-green" : "text-text-tertiary"
                      }`}
                    >
                      {value}
                    </p>
                  </div>
                </div>
              );
              return (
                <>
                  <Tile
                    icon={<Globe2 size={16} />}
                    label="Global"
                    value={globalLabel}
                    active={globalOn}
                  />
                  <Tile
                    icon={<FileText size={16} />}
                    label="Presets"
                    value={presetCount > 0 ? `${presetCount} preset${presetCount > 1 ? "s" : ""}` : "None"}
                    active={presetCount > 0}
                  />
                  <Tile
                    icon={<Layers size={16} />}
                    label="Scopes"
                    value={providerCount + modelCount + namedCount > 0 ? `${providerCount + modelCount + namedCount} active` : "None"}
                    active={providerCount + modelCount + namedCount > 0}
                  />
                </>
              );
            })()}
          </div>
          {settingsQuery.isError ? (
            <Banner tone="danger" surface="raised" live="status">
              {getErrorMessage(settingsQuery.error, "Failed to load system prompt settings")}
            </Banner>
          ) : null}
          <p className="text-caption leading-normal text-text-secondary">
            Add custom system prompts at many levels — global, presets, per provider, per model,
            or per combo/alias — handy for enforcing tone, rules, or context where you need it.
          </p>
        </Stack>
      </CardBody>
      <InjectSystemPromptDialog
        open={open}
        onClose={() => setOpen(false)}
        state={state}
        onSave={(next) =>
          update.mutate(next, {
            onSuccess: () => toast.success("System prompt settings saved"),
            onError: (error) => toast.error(getErrorMessage(error, "Could not save system prompt settings")),
          })
        }
      />
    </Card>
  );
}
