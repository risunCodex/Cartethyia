/**
 * Area 06: display-only model warnings in the provider detail grid.
 *
 * Hover is a native `title` carrying every message (newline-separated), click
 * toggles an inline detail with kind/severity/updatedAt, and the worst severity
 * decides the icon colour. The editor is only reachable on non-builtin rows.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import {
  ModelGrid,
  EditModelModal,
  warningTooltip,
  worstWarningSeverity,
} from "../../src/features/provider-detail/sections/Models";
import { renderMarkup, mount } from "../helpers/render";
import type { ModelCatalogEntry, ModelWarning } from "../../src/data/contracts";

function model(partial: Partial<ModelCatalogEntry> & { readonly modelId: string }): ModelCatalogEntry {
  const { modelId, ...rest } = partial;
  return {
    modelId,
    route: "/chat/completions",
    provider: "demo",
    wireFamily: "chat",
    serviceKind: "llm",
    enabled: true,
    contextLimit: 128000,
    outputLimit: 8192,
    reasoning: false,
    toolCall: true,
    vision: false,
    document: false,
    audio: false,
    mediaGeneration: false,
    cost: null,
    source: "manual",
    sourceUpdatedAt: null,
    ...rest,
  };
}

const WARNINGS: readonly ModelWarning[] = [
  {
    kind: "fallback_model",
    message: "Provider may fall back to another model for this slot.",
    severity: "warn",
    updatedAt: "2026-01-02T03:04:05.000Z",
  },
  {
    kind: "model_refusal",
    message: "Provider may refuse some requests.",
    severity: "critical",
  },
];

describe("warning projection helpers", () => {
  test("hover text joins every message on its own line", () => {
    const title = warningTooltip(WARNINGS);
    expect(title).toContain("Provider may fall back to another model for this slot.");
    expect(title).toContain("Provider may refuse some requests.");
    expect(title.split("\n")).toHaveLength(2);
  });

  test("critical wins over warn, absent severity reads as warn", () => {
    expect(worstWarningSeverity(WARNINGS)).toBe("critical");
    expect(worstWarningSeverity([{ kind: "a", message: "b" }])).toBe("info");
    expect(worstWarningSeverity([{ kind: "a", message: "b", severity: "info" }])).toBe("info");
  });
});

describe("ModelGrid warning badge", () => {
  test("no warnings means no badge and no aria-label", () => {
    const markup = renderMarkup(
      createElement(ModelGrid, {
        providerId: "demo",
        models: [model({ modelId: "clean-model" })],
        thinkingEffort: "auto",
      }),
    );
    expect(markup).not.toContain('aria-label="Model warnings:');
    expect(markup).not.toContain('role="button"');
  });

  test("the badge has a native title, aria-label, role, tabIndex and worst-severity colour", () => {
    const markup = renderMarkup(
      createElement(ModelGrid, {
        providerId: "demo",
        models: [model({ modelId: "warned-model", warnings: WARNINGS })],
        thinkingEffort: "auto",
      }),
    );
    expect(markup).toContain('aria-label="Model warnings: 2"');
    expect(markup).toContain('role="button"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain("cursor-help");
    expect(markup).toContain("Provider may fall back to another model for this slot.");
    expect(markup).toContain("Provider may refuse some requests.");
    expect(markup).toContain('data-severity="critical"');
    expect(markup).toContain("text-red");
  });

  test("click toggles an inline detail with kind, message and updatedAt", async () => {
    const view = await mount(
      createElement(ModelGrid, {
        providerId: "demo",
        models: [model({ modelId: "warned-model", warnings: WARNINGS })],
        thinkingEffort: "auto",
      }),
    );
    try {
      const badge = view.find('[aria-label="Model warnings: 2"]');
      expect(badge).not.toBeNull();
      expect(view.find('[data-testid="model-warning-details"]')).toBeNull();
      await view.click('[aria-label="Model warnings: 2"]');
      await view.flush();
      const detail = view.find('[data-testid="model-warning-details"]');
      expect(detail).not.toBeNull();
      expect(detail?.textContent).toContain("fallback_model");
      expect(detail?.textContent).toContain("2026-01-02T03:04:05.000Z");
      expect(detail?.textContent).toContain("model_refusal");
      expect(badge?.getAttribute("aria-expanded")).toBe("true");
      await view.click('[aria-label="Model warnings: 2"]');
      await view.flush();
      expect(view.find('[data-testid="model-warning-details"]')).toBeNull();
    } finally {
      view.unmount();
    }
  });

  test("built-in rows have no edit pencil but warnings still render", () => {
    const markup = renderMarkup(
      createElement(ModelGrid, {
        providerId: "demo",
        models: [model({ modelId: "builtin-warned", source: "builtin", warnings: WARNINGS })],
        thinkingEffort: "auto",
      }),
    );
    expect(markup).toContain('aria-label="Model warnings: 2"');
    expect(markup).not.toContain("Edit builtin-warned limits and capabilities");
  });
});

describe("EditModelModal warnings section", () => {
  test("renders existing warnings and add/remove/clear controls", async () => {
    // The dialog renders through a portal, so it needs a live DOM.
    const view = await mount(
      createElement(EditModelModal, {
        providerId: "demo",
        model: model({ modelId: "editable", warnings: WARNINGS }),
        onClose: () => undefined,
      }),
    );
    await view.flush();
    try {
      const markup = document.body.innerHTML;
      expect(markup).toContain("Warnings");
    expect(markup).toContain("Add warning");
    expect(markup).toContain("Clear");
      expect(markup).toContain('aria-label="Remove warning 1"');
      expect(markup).toContain("fallback_model");
      expect(markup).toContain("Provider may refuse some requests.");
    } finally {
      view.unmount();
    }
  });

  test("a row without warnings still offers the editor", async () => {
    const view = await mount(
      createElement(EditModelModal, {
        providerId: "demo",
        model: model({ modelId: "editable-clean" }),
        onClose: () => undefined,
      }),
    );
    await view.flush();
    try {
      const markup = document.body.innerHTML;
      expect(markup).toContain("Warnings");
      expect(markup).toContain("No warnings. Add one");
      expect(markup).toContain("Add warning");
    } finally {
      view.unmount();
    }
  });
});
