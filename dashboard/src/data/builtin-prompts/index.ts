/**
 * Built-in system-prompt presets offered in the dashboard. They are shown to
 * every tenant by default so an operator can pick one and save it as a real
 * preset; the text lives here as bundled raw assets (Vite `?raw` imports).
 *
 * `mergeBuiltinPresets` overlays them onto any loaded configuration without
 * overriding a tenant's own saved preset that happens to share an id, so once
 * an operator edits and saves a built-in, their version wins.
 */
import type { SystemPromptPreset } from "../../../../src/console/system-prompt/contracts";
import jinhsiAgentRaw from "./jinhsi-agent.txt?raw";
import generalJBreakRaw from "./general-jbreak.txt?raw";

export const BUILTIN_PRESETS: readonly SystemPromptPreset[] = [
  {
    id: "builtin-jinhsi-agent",
    name: "Jinhsi Agent by risun",
    enabled: true,
    mode: "append",
    text: jinhsiAgentRaw,
  },
  {
    id: "builtin-general-jbreak",
    name: "General JBreak",
    enabled: true,
    mode: "append",
    text: generalJBreakRaw,
  },
];

/** A stable id → preset map of the built-ins. */
export const BUILTIN_PRESET_BY_ID: Readonly<Record<string, SystemPromptPreset>> =
  Object.fromEntries(BUILTIN_PRESETS.map((preset) => [preset.id, preset]));

/**
 * Returns the configuration with the built-in presets available. A tenant's
 * own preset with the same id wins (so edits to a built-in persist); otherwise
 * the built-ins are added but never implicitly written on their own.
 */
export function mergeBuiltinPresets<T extends { presets: Readonly<Record<string, SystemPromptPreset>> }>(
  base: T,
): T {
  const presets: Record<string, SystemPromptPreset> = { ...base.presets };
  for (const preset of BUILTIN_PRESETS) {
    if (presets[preset.id] === undefined) presets[preset.id] = preset;
  }
  return { ...base, presets };
}
