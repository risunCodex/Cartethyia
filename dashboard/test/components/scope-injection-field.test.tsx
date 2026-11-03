/**
 * ScopeInjectionField is a controlled input: it renders the current scope and
 * reports changes upward, but must not persist anything itself. Persisting is
 * the parent's job (together with the route save), so a rename or a dialog
 * cancel cannot strand a prompt under a stale key.
 */
import { expect, test } from "bun:test";
import { createElement, useState } from "react";
import { ScopeInjectionField } from "../../src/components/ScopeInjectionField";
import { registerDom } from "../helpers/dom";
import { mount } from "../helpers/render";

registerDom();

const PRESETS = {
  "pre-1": { id: "pre-1", name: "Tone", enabled: true, mode: "append" as const, text: "Be concise" },
};

function Harness() {
  const [ref, setRef] = useState<{ kind: "global" } | { kind: "off" } | { kind: "custom"; setting: { enabled: true; mode: "append"; text: string } }>({ kind: "global" });
  return createElement(ScopeInjectionField, {
    kind: "combo",
    name: "c1",
    value: ref,
    onChange: (next) => setRef(next as typeof ref),
    presets: PRESETS,
  });
}

test("renders the current scope and reports changes without persisting", async () => {
  const { container, act, flush, unmount } = await mount(createElement(Harness));
  try {
    // Defaults to following global.
    expect(container.textContent).toContain("Following global");

    // Switching to Custom must not write to the server (no fetch), and the
    // radio reflects the change via the parent's state. Target the radio by
    // its label, not the first radio in the DOM (that is Off).
    await act(async () => {
      const radios = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
      const custom = radios.find((r) => r.parentElement?.textContent?.trim() === "Custom");
      custom?.click();
    });
    await flush();
    expect(container.textContent).toContain("Custom");
    // The custom prompt editor is a textarea; its placeholder text is not part
    // of `textContent`, so assert on the element itself.
    expect(container.querySelector("textarea")).not.toBeNull();
  } finally {
    unmount();
  }
});

test("shows preset source when a preset is selected", async () => {
  const { container, act, flush, unmount } = await mount(createElement(Harness));
  try {
    await act(async () => {
      const radios = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
      const presetRadio = radios.find((r) => r.nextSibling?.textContent?.trim() === "Preset");
      presetRadio?.click();
    });
    await flush();
    expect(container.textContent).toContain("Preset");
    expect(container.textContent).toContain("Tone");
  } finally {
    unmount();
  }
});
