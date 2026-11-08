/**
 * The InferHub market section's expand/collapse boundary.
 *
 * The bug this exists for: the toggle was on the whole card, so clicking a table
 * row, the key field, or a checkbox collapsed the section out from under the
 * operator. The header row is now the only hit target, and the body is content.
 *
 * Pins both directions — the header toggles, and the body does not.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { mount } from "../helpers/render";
import { registerDom } from "../helpers/dom";
import { queryKeys } from "../../src/data/query-keys";
import { InferhubMarket } from "../../src/features/provider-detail/sections/InferhubMarket";
import type { InferhubSummary } from "../../src/data/contracts";

registerDom();

const SUMMARY: InferhubSummary = {
  models: [
    {
      id: "cc/claude-opus-4-6",
      prefix: "cc",
      family: "Claude Code",
      modelId: "claude-opus-4-6",
      aliasKey: "claude-opus-4-6",
      providersLive: 36,
      minAskIn: 5,
      minAskOut: 25,
      maxAskIn: 10,
      maxAskOut: 50,
      capacityPriceIn: 5,
      capacityPriceOut: 25,
      officialIn: 10,
      officialOut: 50,
      lastRate: null,
      cacheHitRate: null,
      routable: true,
      tiersIn: [{ price: 5, discountPct: 50, avail: 36 }],
      tiersOut: [{ price: 25, discountPct: 50, avail: 36 }],
      systemPromptNote: null,
      health: { successRatePct: 99, avgTtftMs: null, avgTps: null, familyState: null },
      capabilities: {
        contextWindow: null,
        maxOutputTokens: null,
        modalities: [],
        outputModality: "text",
        reasoningLevels: [],
        supportsCache: false,
      },
    },
  ],
  providers: [
    {
      prefix: "cc",
      family: "Claude Code",
      activeProviders: 36,
      familyState: "operational",
      availability24hPct: 99.8,
      availability7dPct: 98.1,
      p50DurationMs: null,
      p95DurationMs: null,
      avgTtftMs1h: null,
      avgTps1h: null,
    },
  ],
  pricingConfig: null,
  meta: { fetchedAt: Date.now(), ageSeconds: 3, stale: false },
  error: null,
};

const seed = [{ key: queryKeys.inferhub.summary, data: SUMMARY }];

/** The real upstream note: one long paragraph per prefix. */
const SYSTEM_NOTE =
  "Adds a short system note ahead of your system prompt (formatting guidance, " +
  "plus an identity line when a known coding agent such as Claude Code or Codex " +
  "is detected) and may reword agent and product identity wording inside it.";

const NOTE_SUMMARY: InferhubSummary = {
  ...SUMMARY,
  models: [{ ...SUMMARY.models[0]!, systemPromptNote: SYSTEM_NOTE }],
};
const NOTE_SEED = [{ key: queryKeys.inferhub.summary, data: NOTE_SUMMARY }];

/** Two providers whose alphabetical order is the opposite of their price. */
function modelOn(prefix: string, family: string, id: string, minAskIn: number): InferhubSummary["models"][number] {
  return {
    ...SUMMARY.models[0]!,
    id,
    prefix,
    family,
    aliasKey: id,
    minAskIn,
  };
}

const MULTI_SUMMARY: InferhubSummary = {
  ...SUMMARY,
  models: [
    // Z.AI is cheapest; it must still sort last under Provider (A–Z).
    modelOn("zai", "Z.AI", "zai/glm-5.3", 0.001),
    modelOn("ag", "Antigravity", "ag/claude-opus-4-6", 9),
  ],
  providers: [
    { prefix: "zai", family: "Z.AI", activeProviders: 10, familyState: "operational", availability24hPct: 99, availability7dPct: 97, p50DurationMs: null, p95DurationMs: null, avgTtftMs1h: null, avgTps1h: null },
    { prefix: "ag", family: "Antigravity", activeProviders: 10, familyState: "operational", availability24hPct: 99.9, availability7dPct: 98, p50DurationMs: null, p95DurationMs: null, avgTtftMs1h: null, avgTps1h: null },
  ],
};
const MULTI_SEED = [{ key: queryKeys.inferhub.summary, data: MULTI_SUMMARY }];

function toggle(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((el) =>
    /inferhub market/i.test(el.getAttribute("aria-label") ?? ""),
  );
  if (button === undefined) throw new Error("expand/collapse toggle not rendered");
  return button as HTMLButtonElement;
}

/** A provider group's own expand/collapse button. */
function groupButton(container: HTMLElement, family: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((el) =>
    new RegExp(`(Collapse|Expand) ${family} models`, "i").test(el.getAttribute("aria-label") ?? ""),
  ) as HTMLButtonElement | undefined;
}

describe("InferhubMarket collapse", () => {
  test("is collapsed by default", async () => {
    const view = await mount(createElement(InferhubMarket), { seed });
    await view.flush();
    expect(view.container.textContent).toContain("InferHub market");
    // Collapsed: no table, no key field.
    expect(view.container.textContent).not.toContain("cc/claude-opus-4-6");
    expect(view.container.querySelectorAll('input[type="password"]')).toHaveLength(0);
    view.unmount();
  });

  test("the header toggle expands it", async () => {
    const view = await mount(createElement(InferhubMarket), { seed });
    await view.flush();
    await view.act(() => {
      toggle(view.container).click();
    });
    await view.flush();
    expect(view.container.textContent).toContain("cc/claude-opus-4-6");
    view.unmount();
  });

  test("clicking body content does not collapse it", async () => {
    const view = await mount(createElement(InferhubMarket), { seed });
    await view.flush();
    await view.act(() => {
      toggle(view.container).click();
    });
    await view.flush();
    expect(view.container.textContent).toContain("cc/claude-opus-4-6");

    // A model row: the exact click that used to collapse the whole section.
    const row = view.container.querySelector("tbody tr");
    expect(row).not.toBeNull();
    await view.act(() => {
      row!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await view.flush();
    expect(view.container.textContent).toContain("cc/claude-opus-4-6");

    // The key field too.
    const input = view.container.querySelector('input[type="password"]');
    expect(input).not.toBeNull();
    await view.act(() => {
      input!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await view.flush();
    expect(view.container.textContent).toContain("cc/claude-opus-4-6");
    view.unmount();
  });

  test("toggling a checkbox in the body does not collapse it", async () => {
    const view = await mount(createElement(InferhubMarket), { seed });
    await view.flush();
    await view.act(() => {
      toggle(view.container).click();
    });
    await view.flush();
    const box = [...view.container.querySelectorAll('input[type="checkbox"]')].find((el) =>
      /show all/i.test(el.closest("label")?.textContent ?? ""),
    ) as HTMLInputElement | undefined;
    expect(box).toBeDefined();
    await view.act(() => {
      box!.click();
    });
    await view.flush();
    expect(view.container.textContent).toContain("cc/claude-opus-4-6");
    view.unmount();
  });

  test("the header toggle collapses it again", async () => {
    const view = await mount(createElement(InferhubMarket), { seed });
    await view.flush();
    await view.act(() => {
      toggle(view.container).click();
    });
    await view.flush();
    await view.act(() => {
      toggle(view.container).click();
    });
    await view.flush();
    expect(view.container.textContent).not.toContain("cc/claude-opus-4-6");
    view.unmount();
  });

  test("models are grouped under their provider, expanded by default", async () => {
    const view = await mount(createElement(InferhubMarket), { seed });
    await view.flush();
    await view.act(() => {
      toggle(view.container).click();
    });
    await view.flush();
    // The provider is its own block, and its models are visible without a
    // second click.
    expect(view.container.textContent).toContain("Claude Code");
    expect(view.container.textContent).toContain("cc/claude-opus-4-6");
    const groupToggle = groupButton(view.container, "Claude Code");
    expect(groupToggle?.getAttribute("aria-expanded")).toBe("true");
    view.unmount();
  });

  test("a provider group collapses and re-expands", async () => {
    const view = await mount(createElement(InferhubMarket), { seed });
    await view.flush();
    await view.act(() => {
      toggle(view.container).click();
    });
    await view.flush();
    await view.act(() => {
      groupButton(view.container, "Claude Code")!.click();
    });
    await view.flush();
    expect(view.container.textContent).not.toContain("cc/claude-opus-4-6");
    // The provider header stays: collapsing hides models, not the provider.
    expect(view.container.textContent).toContain("Claude Code");
    await view.act(() => {
      groupButton(view.container, "Claude Code")!.click();
    });
    await view.flush();
    expect(view.container.textContent).toContain("cc/claude-opus-4-6");
    view.unmount();
  });

  test("availability is on by default", async () => {
    const view = await mount(createElement(InferhubMarket), { seed });
    await view.flush();
    await view.act(() => {
      toggle(view.container).click();
    });
    await view.flush();
    const box = [...view.container.querySelectorAll('input[type="checkbox"]')].find((el) =>
      /show availability/i.test(el.closest("label")?.textContent ?? ""),
    ) as HTMLInputElement | undefined;
    expect(box?.checked).toBe(true);
    expect(view.container.textContent).toContain("operational");
    expect(view.container.textContent).toContain("24h");
    view.unmount();
  });

  test("groups are ordered A-Z by provider name", async () => {
    const view = await mount(createElement(InferhubMarket), { seed: MULTI_SEED });
    await view.flush();
    await view.act(() => {
      toggle(view.container).click();
    });
    await view.flush();
    const headers = [...view.container.querySelectorAll("button")]
      .map((el) => el.getAttribute("aria-label") ?? "")
      // Group toggles are "Collapse <family> models"; the sort control's label
      // is "Sort InferHub models" and must not be counted.
      .filter((label) => /^(Collapse|Expand) .+ models$/i.test(label));
    // "Antigravity" before "Z.AI" regardless of price or availability.
    expect(headers[0]).toContain("Antigravity");
    expect(headers[headers.length - 1]).toContain("Z.AI");
    view.unmount();
  });

  test("the system prompt note sits on the provider group", async () => {
    const view = await mount(createElement(InferhubMarket), { seed: NOTE_SEED });
    await view.flush();
    await view.act(() => {
      toggle(view.container).click();
    });
    await view.flush();
    // Present once, on the group — not repeated per row.
    const text = view.container.textContent ?? "";
    expect(text).toContain("Adds a short system note");
    expect(text.split("Adds a short system note").length - 1).toBe(1);
    // Collapsing the group hides it with the models.
    await view.act(() => {
      groupButton(view.container, "Claude Code")!.click();
    });
    await view.flush();
    expect(view.container.textContent).not.toContain("Adds a short system note");
    view.unmount();
  });

  test("survives summary arriving after the first render", async () => {
    // The bug this pins: a hook sat below the "no data yet" early return, so
    // the render that finally had summary ran one more hook than the render
    // that did not. React reads a changed hook count as a changed hook order
    // and throws "Rendered more hooks than during the previous render".
    //
    // Mounting with no seed gives that exact sequence: first render has no
    // summary, then the query resolves and the component re-renders with one.
    const view = await mount(createElement(InferhubMarket), {});
    await view.flush();
    // Seed the cache after mount, then let the component re-render with data.
    await view.act(async () => {
      view.queryClient.setQueryData(queryKeys.inferhub.summary, SUMMARY);
    });
    await view.flush();
    // No throw, and the data renders.
    expect(view.container.textContent).toContain("InferHub market");
    await view.act(() => {
      toggle(view.container).click();
    });
    await view.flush();
    expect(view.container.textContent).toContain("Claude Code");
    expect(view.container.textContent).toContain("cc/claude-opus-4-6");
    view.unmount();
  });
});
