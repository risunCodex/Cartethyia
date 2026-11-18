import { describe, expect, test } from "bun:test";
import type { SystemPromptPreset } from "../../../src/protocol/system-prompt-contracts";
import {
  BUILTIN_PRESETS,
  mergeBuiltinPresets,
} from "../../src/data/builtin-prompts";

function mergeWith(presets: Record<string, SystemPromptPreset>) {
  return mergeBuiltinPresets({ presets });
}

describe("mergeBuiltinPresets", () => {
  test("adds built-ins to an empty configuration", () => {
    const merged = mergeWith({});
    for (const preset of BUILTIN_PRESETS) {
      expect(merged.presets[preset.id]).toEqual(preset);
    }
  });

  test("a tenant's saved copy wins over the built-in", () => {
    const merged = mergeWith({
      "builtin-jinhsi-jgeneral": {
        id: "builtin-jinhsi-jgeneral",
        name: "My custom name",
        enabled: false,
        mode: "override",
        text: "custom",
      },
    });
    expect(merged.presets["builtin-jinhsi-jgeneral"]).toMatchObject({
      name: "My custom name",
      enabled: false,
      mode: "override",
      text: "custom",
    });
  });

  test("a saved copy still carrying a retired built-in label is re-labeled", () => {
    const merged = mergeWith({
      "builtin-jinhsi-jgeneral": {
        id: "builtin-jinhsi-jgeneral",
        name: "Jinxi JGeneral",
        enabled: true,
        mode: "append",
        text: "kept",
      },
      "builtin-general-jbreak": {
        id: "builtin-general-jbreak",
        name: "General JBreak",
        enabled: true,
        mode: "append",
        text: "kept too",
      },
    });
    // Label advances to the current built-in name; text/mode/enabled stay.
    expect(merged.presets["builtin-jinhsi-jgeneral"]).toMatchObject({
      name: "Jinxi General Agent",
      mode: "append",
      enabled: true,
      text: "kept",
    });
    expect(merged.presets["builtin-general-jbreak"]).toMatchObject({
      name: "General Assistant",
      mode: "append",
      enabled: true,
      text: "kept too",
    });
  });
});
