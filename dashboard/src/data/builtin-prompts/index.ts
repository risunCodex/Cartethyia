/**
 * Built-in system-prompt presets offered in the dashboard. They are shown to
 * every tenant by default so an operator can pick one and save it as a real
 * preset; the text lives here as bundled raw assets (Vite `?raw` imports).
 *
 * `mergeBuiltinPresets` overlays them onto any loaded configuration without
 * overriding a tenant's own saved preset that happens to share an id, so once
 * an operator edits and saves a built-in, their version wins.
 */
import type { SystemPromptPreset } from "../../../../src/protocol/system-prompt-contracts";
import jinhsiJGeneralRaw from "./jinhsi-jgeneral.txt?raw";
import generalJBreakRaw from "./general-jbreak.txt?raw";

export const BUILTIN_PRESETS: readonly SystemPromptPreset[] = [
  {
    id: "builtin-jinhsi-jgeneral",
    name: "Jinxi General Agent",
    enabled: true,
    mode: "append",
    text: jinhsiJGeneralRaw,
  },
  {
    id: "builtin-general-jbreak",
    name: "General Assistant",
    enabled: true,
    mode: "append",
    text: generalJBreakRaw,
  },
];

/** A stable id → preset map of the built-ins. */
export const BUILTIN_PRESET_BY_ID: Readonly<Record<string, SystemPromptPreset>> =
  Object.fromEntries(BUILTIN_PRESETS.map((preset) => [preset.id, preset]));

/**
 * Retired built-in labels, keyed by the id that still carries them.
 *
 * A tenant that saved a built-in before a rename keeps their own copy (the
 * merge never overwrites a saved record), so the old label would survive
 * forever. These are the exact names we retired when the labels changed; a
 * saved record still carrying one is an unrenamed copy of the built-in, so its
 * label is advanced to the current built-in name while text/mode/enabled stay
 * untouched.
 */
const RETIRED_BUILTIN_PRESET_NAMES: Readonly<Record<string, string>> = {
  "builtin-jinhsi-jgeneral": "Jinxi JGeneral",
  "builtin-general-jbreak": "General JBreak",
};

/**
 * Returns the configuration with the built-in presets available. A tenant's
 * own preset with the same id wins (so edits to a built-in persist); otherwise
 * the built-ins are added but never implicitly written on their own. A saved
 * copy that still carries a retired built-in label is re-labeled with the
 * current built-in name.
 */
export function mergeBuiltinPresets<T extends { presets: Readonly<Record<string, SystemPromptPreset>> }>(
  base: T,
): T {
  const presets: Record<string, SystemPromptPreset> = { ...base.presets };
  for (const preset of BUILTIN_PRESETS) {
    const saved = presets[preset.id];
    if (saved === undefined) {
      presets[preset.id] = preset;
    } else if (RETIRED_BUILTIN_PRESET_NAMES[preset.id] === saved.name) {
      presets[preset.id] = { ...saved, name: preset.name };
    }
  }
  return { ...base, presets };
}
