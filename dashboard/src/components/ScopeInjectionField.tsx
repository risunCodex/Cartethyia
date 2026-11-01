/**
 * A compact inline control for scoping system-prompt injection to a named
 * route (combo / alias). Shows the current state (following global, a preset,
 * custom, or off) with an edit button that opens a small dialog reusing the
 * same `ScopeSourcePicker` as the full Inject System Prompt settings.
 *
 * Persists directly to the tenant's system-prompt configuration via the
 * `PUT /system-prompt` surface, so changes made here are applied immediately.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";
import { Stack } from "./ui/stack";
import { FileText } from "lucide-react";
import {
  EMPTY_STATE,
  ScopeSourcePicker,
} from "./InjectSystemPromptPanel";
import { useSystemPrompt, useUpdateSystemPrompt } from "../hooks/system-prompt";
import { toast } from "../lib/toast";
import { getErrorMessage } from "../data/api";
import type {
  ScopePromptRef,
  SystemPromptPreset,
  TenantSystemPrompts,
} from "../../../src/console/system-prompt/contracts";

/** Resolve a scope ref to its label + active state for the status chip. */
function describeRef(ref: ScopePromptRef, presets: Readonly<Record<string, SystemPromptPreset>>): {
  label: string;
  active: boolean;
} {
  if (ref.kind === "off") return { label: "Off", active: false };
  if (ref.kind === "global") return { label: "Following global", active: false };
  if (ref.kind === "preset") {
    const preset = presets[ref.presetId];
    const active = preset?.enabled === true;
    return { label: `Preset · ${preset?.name ?? ref.presetId}`, active };
  }
  const active = ref.setting.enabled;
  return {
    label: active ? (ref.setting.mode === "override" ? "Custom · Override" : "Custom · Append") : "Custom off",
    active,
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
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ScopePromptRef | null>(null);
  const wasOpen = useRef(false);

  const state = settingsQuery.data ?? EMPTY_STATE;
  const savedRef = kind === "combo" ? state.combos[name] : state.aliases[name];
  const ref = savedRef ?? { kind: "global" as const };
  const { label, active } = describeRef(ref, state.presets);

  useEffect(() => {
    if (open && !wasOpen.current) setDraft(savedRef ?? { kind: "global" });
    wasOpen.current = open;
  }, [open, savedRef]);

  const save = (next: ScopePromptRef | null) => {
    const updated: TenantSystemPrompts = {
      ...state,
      combos:
        kind === "combo"
          ? { ...state.combos, [name]: next ?? { kind: "off" } }
          : state.combos,
      aliases:
        kind === "alias"
          ? { ...state.aliases, [name]: next ?? { kind: "off" } }
          : state.aliases,
    };
    update.mutate(updated, {
      onSuccess: () => {
        toast.success("System prompt updated");
        setOpen(false);
      },
      onError: (error) =>
        toast.error(getErrorMessage(error, "Could not update system prompt.")),
    });
  };

  return (
    <div className="flex items-center justify-between gap-3 rounded-control border border-inner-border bg-surface-2 px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <FileText size={14} className="shrink-0 text-text-tertiary" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-caption font-semibold text-text-primary">System prompt</p>
          <div className="mt-0.5 flex items-center gap-2">
            <Badge tone={active ? "ok" : "default"} dot>
              {label}
            </Badge>
          </div>
        </div>
      </div>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        Edit
      </Button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`System prompt · ${kind === "combo" ? "Combo" : "Alias"} "${name}"`}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => save(draft)} disabled={update.isPending}>
              {update.isPending ? "Saving…" : "Save"}
            </Button>
          </>
        }
      >
        <Stack gap="12px">
          <p className="text-badge leading-normal text-text-tertiary">
            This injection applies only when a request arrives through "{name}".
            Set it to Off to stop injection for this {kind} without touching the
            global prompt.
          </p>
          <ScopeSourcePicker
            id={`scp-${kind}-${name}`}
            ref={draft ?? { kind: "global" }}
            presets={state.presets}
            onChange={setDraft}
            rows={5}
            allowOff
          />
        </Stack>
      </Dialog>
    </div>
  );
}
