/**
 * The Inject System Prompt modal paginates every surfaced list so a long
 * catalog never renders all rows at once. This suite seeds >PAGE_SIZE combos,
 * aliases, providers, and models, and proves only the first page renders plus
 * the pager works.
 */
import { expect, test } from "bun:test";
import { createElement } from "react";
import { InjectSystemPromptDialog } from "../../src/components/InjectSystemPromptPanel";
import { queryKeys } from "../../src/data/query-keys";
import { createTestQueryClient, mount, type Mounted } from "../helpers/render";
import { registerDom } from "../helpers/dom";
import type { TenantSystemPrompts } from "../../../src/console/system-prompt/contracts";
import type { ProviderResponse } from "../../src/data/contracts";

registerDom();

function comboRow(i: number) {
  return {
    id: `c${i}`,
    tenantId: "t",
    name: `combo-${i}`,
    members: ["m1", "m2"],
    strategy: "fallback",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
}

function aliasRow(i: number) {
  return {
    id: `a${i}`,
    tenantId: "t",
    alias: `alias-${i}`,
    targetModel: "model-x",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
}

function provider(i: number): ProviderResponse {
  return {
    providerId: `prov-${i}`,
    serviceKinds: ["llm"],
    displayName: `Provider ${i}`,
    enabled: true,
    isBuiltIn: true,
    requiresAccount: true,
    hasAdapterUserAgent: false,
    supportsWebSearch: false,
    supportsModelDiscovery: false,
    routeIdentityVersions: {
      codex: "",
      claude: "",
    },
  };
}

function model(i: number) {
  return {
    modelId: `model-${i}`,
    route: `prov-0/model-${i}`,
    provider: "prov-0",
    label: `Model ${i}`,
    enabled: true,
  };
}

const EMPTY: TenantSystemPrompts = {
  global: null,
  presets: {},
  providers: {},
  models: {},
  combos: {},
  aliases: {},
};

function seed() {
  const client = createTestQueryClient();
  client.setQueryData(queryKeys.providers.all, Array.from({ length: 12 }, (_, i) => provider(i)));
  client.setQueryData(queryKeys.providers.models("prov-0"), Array.from({ length: 12 }, (_, i) => model(i)));
  client.setQueryData(queryKeys.modelRouting.combos, Array.from({ length: 12 }, (_, i) => comboRow(i)));
  client.setQueryData(queryKeys.modelRouting.aliases, Array.from({ length: 12 }, (_, i) => aliasRow(i)));
  client.setQueryData(queryKeys.systemPrompt.config, EMPTY);
  return client;
}

async function mountDialog(): Promise<Mounted> {
  const client = seed();
  const view = await mount(
    createElement(InjectSystemPromptDialog, {
      open: true,
      onClose: () => {},
      state: EMPTY,
      onSave: () => {},
    }),
    { queryClient: client },
  );
  await view.flush();
  return view;
}

/** Clicks the "Next" button inside the given pager; throws when absent. */
async function clickNext(view: Mounted, testId: string): Promise<void> {
  const pager = view.findAll(`[data-testid="${testId}"]`)[0];
  if (!pager) throw new Error(`pager not found: ${testId}`);
  const next = [...pager.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Next");
  if (!next) throw new Error(`Next button not found in ${testId}`);
  await view.act(async () => {
    next?.click();
  });
  await view.flush();
}

test("combos & aliases area paginates and searches", async () => {
  const view = await mountDialog();
  try {
    // The surfaced list is a responsive 2-column grid (1 column at narrow
    // widths), matching the per-model and per-provider sections instead of a
    // full-width vertical stack.
    const grid = view.findAll('[data-testid="isp-named-grid"]')[0];
    expect(grid?.className).toContain("grid-cols-2");
    expect(grid?.className).toContain("max-small:grid-cols-1");
    // No search: the first page shows PAGE_SIZE rows (combos and aliases are
    // flattened, so 8 of the 24 total). Combos sort first, so page 1 is
    // combo-0 .. combo-7.
    expect(view.findAll('[data-testid="isp-named-pagination"]').length).toBe(1);
    expect(document.body.textContent).toContain("combo-0");
    expect(document.body.textContent).toContain("combo-7");
    expect(document.body.textContent).not.toContain("combo-8");

    // Next page reveals the rest of the combos.
    await clickNext(view, "isp-named-pagination");
    expect(document.body.textContent).toContain("combo-8");
    expect(document.body.textContent).toContain("combo-9");
    expect(document.body.textContent).not.toContain("combo-0");
  } finally {
    view.unmount();
  }
});

test("provider section paginates", async () => {
  const view = await mountDialog();
  try {
    expect(view.findAll('[data-testid="isp-provider-pagination"]').length).toBe(1);
    // Use the display name, not the provider id: `prov-0` also appears in the
    // per-model routes, and `Provider 0` is a substring of the count header
    // ("Provider 012 models"). `Provider 7` / `Provider 8` are unique.
    expect(document.body.textContent).toContain("Provider 7");
    expect(document.body.textContent).not.toContain("Provider 8");

    await clickNext(view, "isp-provider-pagination");
    expect(document.body.textContent).toContain("Provider 8");
    expect(document.body.textContent).toContain("Provider 9");
    expect(document.body.textContent).not.toContain("Provider 7");
  } finally {
    view.unmount();
  }
});

test("per-model grid paginates", async () => {
  const view = await mountDialog();
  try {
    expect(view.findAll('[data-testid="isp-model-pagination"]').length).toBe(1);
    expect(document.body.textContent).toContain("model-0");
    expect(document.body.textContent).toContain("model-7");
    expect(document.body.textContent).not.toContain("model-8");

    await clickNext(view, "isp-model-pagination");
    expect(document.body.textContent).toContain("model-8");
    expect(document.body.textContent).toContain("model-9");
    expect(document.body.textContent).not.toContain("model-0");
  } finally {
    view.unmount();
  }
});
