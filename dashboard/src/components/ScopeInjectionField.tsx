/**
 * An inline control for scoping system-prompt injection to a named route
 * (combo / alias). Shows the current state and the editable choices directly —
 * Off / Global / Preset / Custom — with no intermediate dialog. Every change
 * persists immediately to the tenant's system-prompt configuration via
 * `PUT /system-prompt`.
 */
import { type ReactNode } from "react";
import { Badge } from "./ui/badge";
import { Select } from "./ui/select";
import { Textarea } from "./ui/input";
import { FileText } from "lucide-react";
import { EMPTY_STATE } from "./InjectSystemPromptPanel";
import { useSystemPrompt, useUpdateSystemPrompt } from "../hooks/system-prompt";
import { toast } from "../lib/toast";
import { getErrorMessage } from "../data/api";
import type {
  PromptSetting,
  ScopePromptRef,
  SystemPromptPreset,
  TenantSystemPrompts,
} from "../../../src/console/system-prompt/contracts";

const MODE_OPTIONS = [
  { value: "append", label: "Append" },
  { value: "override", label: "Override" },
] as const;

/** The current source kind, normalized (undefined → "global"). */
function sourceKind(ref: ScopePromptRef): "off" | "global" | "preset" | "custom" {
  return ref.kind;
}

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
 * `name` is the combo/alias name as keyed in the tenant's saved config.
 */
export function ScopeInjectionField({
  kind,
  name,
}: {
  readonly kind: "combo" | "alias";
  readonly name: string;
}): ReactNode {
  const settingsQuery = useSystemPrompt();
  const update = useUpdateSystemPrompt();

  const state = settingsQuery.data ?? EMPTY_STATE;
  const savedRef = kind === "combo" ? state.combos[name] : state.aliases[name];
  const ref = savedRef ?? { kind: "global" as const };
  const { label, active } = describeRef(ref, state.presets);

  const save = (next: ScopePromptRef) => {
    const updated: TenantSystemPrompts = {
      ...state,
      combos:
        kind === "combo"
          ? { ...state.combos, [name]: next }
          : state.combos,
      aliases:
        kind === "alias"
          ? { ...state.aliases, [name]: next }
          : state.aliases,
    };
    update.mutate(updated, {
      onSuccess: () => toast.success("System prompt updated"),
      onError: (error) =>
        toast.error(getErrorMessage(error, "Could not update system prompt.")),
    });
  };

  const kindNow = sourceKind(ref);

  const presetList = Object.values(state.presets);

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
            onChange={() => save({ kind: "off" })}
            className="accent-accent"
          />
          Off
        </label>
        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-control border border-inner-border bg-surface-2 px-2 py-2 text-badge font-medium text-text-primary select-none has-checked:border-accent has-checked:bg-accent-soft">
          <input
            type="radio"
            name={`scp-${kind}-${name}`}
            checked={kindNow === "global"}
            onChange={() => save({ kind: "global" })}
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
              save(first ? { kind: "preset", presetId: first.id } : { kind: "global" });
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
            onChange={() => save({ kind: "custom", setting: { enabled: true, mode: "append", text: "" } })}
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
            onValueChange={(v) => save({ kind: "preset", presetId: v })}
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
                save({
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
              save({
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
