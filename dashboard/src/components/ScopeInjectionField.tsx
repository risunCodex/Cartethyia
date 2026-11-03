/**
 * An inline control for scoping system-prompt injection to a named route
 * (combo / alias). Shows the current state and the editable choices directly —
 * Off / Global / Preset / Custom — with no intermediate dialog.
 *
 * The component is controlled: the caller owns the current `ScopePromptRef`
 * and receives changes through `onChange`. The parent decides when to persist
 * (typically together with the route save), so a rename or a cancel cannot
 * strand a prompt under a stale key.
 */
import { type ReactNode } from "react";
import { Badge } from "./ui/badge";
import { Select } from "./ui/select";
import { Textarea } from "./ui/input";
import { FileText } from "lucide-react";
import type {
  PromptSetting,
  ScopePromptRef,
  SystemPromptPreset,
} from "../../../src/console/system-prompt/contracts";

const MODE_OPTIONS = [
  { value: "append", label: "Append" },
  { value: "override", label: "Override" },
] as const;

/** Status label for the chip. */
function describeRef(ref: ScopePromptRef, presets: Readonly<Record<string, SystemPromptPreset>>): {
  label: string;
  active: boolean;
} {
  if (ref.kind === "off") return { label: "Off", active: false };
  if (ref.kind === "global") return { label: "Following global", active: false };
  if (ref.kind === "preset") {
    const preset = presets[ref.presetId];
    return {
      label: `Preset · ${preset?.name ?? ref.presetId}`,
      active: preset?.enabled === true,
    };
  }
  return {
    label: ref.setting.enabled ? "Custom" : "Custom off",
    active: ref.setting.enabled,
  };
}

/**
 * Inline system-prompt injection field for a named scope (combo or alias).
 * `name` is the scope name as keyed in the tenant's saved config; it only
 * disambiguates form control ids.
 */
export function ScopeInjectionField({
  kind,
  name,
  value,
  onChange,
  presets,
}: {
  readonly kind: "combo" | "alias";
  readonly name: string;
  readonly value: ScopePromptRef;
  readonly onChange: (next: ScopePromptRef) => void;
  readonly presets: Readonly<Record<string, SystemPromptPreset>>;
}): ReactNode {
  const ref = value;
  const { label, active } = describeRef(ref, presets);
  const kindNow = ref.kind;
  const presetList = Object.values(presets);

  return (
    <div className="rounded-control border border-inner-border bg-surface-2 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <FileText size={14} className="shrink-0 text-text-tertiary" aria-hidden="true" />
          <p className="text-caption font-semibold text-text-primary">System prompt</p>
        </div>
        <Badge tone={active ? "ok" : "default"} dot className="shrink-0">
          {label}
        </Badge>
      </div>

      <div className="mt-3 grid grid-cols-4 gap-2 max-small:grid-cols-2" role="radiogroup" aria-label="System prompt source">
        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-control border border-inner-border bg-surface-2 px-2 py-2 text-badge font-medium text-text-primary select-none has-checked:border-accent has-checked:bg-accent-soft">
          <input
            type="radio"
            name={`scp-${kind}-${name}`}
            checked={kindNow === "off"}
            onChange={() => onChange({ kind: "off" })}
            className="accent-accent"
          />
          Off
        </label>
        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-control border border-inner-border bg-surface-2 px-2 py-2 text-badge font-medium text-text-primary select-none has-checked:border-accent has-checked:bg-accent-soft">
          <input
            type="radio"
            name={`scp-${kind}-${name}`}
            checked={kindNow === "global"}
            onChange={() => onChange({ kind: "global" })}
            className="accent-accent"
          />
          Global
        </label>
        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-control border border-inner-border bg-surface-2 px-2 py-2 text-badge font-medium text-text-primary select-none has-checked:border-accent has-checked:bg-accent-soft">
          <input
            type="radio"
            name={`scp-${kind}-${name}`}
            checked={kindNow === "preset"}
            onChange={() => {
              const first = presetList.find((p) => p.enabled) ?? presetList[0];
              onChange(first ? { kind: "preset", presetId: first.id } : { kind: "global" });
            }}
            className="accent-accent"
          />
          Preset
        </label>
        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-control border border-inner-border bg-surface-2 px-2 py-2 text-badge font-medium text-text-primary select-none has-checked:border-accent has-checked:bg-accent-soft">
          <input
            type="radio"
            name={`scp-${kind}-${name}`}
            checked={kindNow === "custom"}
            onChange={() => onChange({ kind: "custom", setting: { enabled: true, mode: "append", text: "" } })}
            className="accent-accent"
          />
          Custom
        </label>
      </div>

      {kindNow === "preset" ? (
        <div className="mt-3">
          <Select
            aria-label="Preset"
            value={ref.kind === "preset" ? ref.presetId : ""}
            onValueChange={(v) => onChange({ kind: "preset", presetId: v })}
            options={presetList.map((p) => ({ value: p.id, label: `${p.name}${p.enabled ? "" : " (off)"}` }))}
            size="sm"
            className="w-full"
          />
          {presetList.length === 0 ? (
            <p className="mt-2 text-badge text-text-tertiary">
              No presets yet — create one in Inject System Prompt first.
            </p>
          ) : null}
        </div>
      ) : null}

      {kindNow === "custom" ? (
        <div className="mt-3">
          <div className="mb-2 flex items-center gap-3">
            <Select
              aria-label="Injection mode"
              value={ref.kind === "custom" ? ref.setting.mode : "append"}
              onValueChange={(v) =>
                onChange({
                  kind: "custom",
                  setting: {
                    enabled: true,
                    mode: v as PromptSetting["mode"],
                    text: ref.kind === "custom" ? ref.setting.text : "",
                  },
                })
              }
              options={MODE_OPTIONS}
              size="sm"
              className="w-40"
            />
            {ref.kind === "custom" ? (
              <span className="text-badge tabular-nums text-text-tertiary">
                {ref.setting.text.length.toLocaleString()} chars
              </span>
            ) : null}
          </div>
          <Textarea
            id={`scp-${kind}-${name}-text`}
            rows={4}
            value={ref.kind === "custom" ? ref.setting.text : ""}
            onChange={(event) =>
              onChange({
                kind: "custom",
                setting: {
                  enabled: true,
                  mode: ref.kind === "custom" ? ref.setting.mode : "append",
                  text: event.target.value,
                },
              })
            }
            placeholder="Injected system prompt…"
          />
        </div>
      ) : null}
    </div>
  );
}
