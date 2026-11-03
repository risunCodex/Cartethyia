/**
 * Providers page pagination: 8 cards per section page, with a single
 * Show All / Paginated toggle (next to Hide unconfigured) that switches the
 * whole page between paginated and full-list rendering.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { mount } from "../helpers/render";
import { registerDom } from "../helpers/dom";
import Providers from "../../src/features/providers/ProvidersPage";
import { queryKeys } from "../../src/data/query-keys";
import type { ProviderResponse } from "../../src/data/contracts";

registerDom();

const COLLAPSED_KEY = "cartethyia.providerSectionsCollapsed";
const DISPLAY_MODE_KEY = "cartethyia:providers:display-mode";

// The "Other API Key Providers" section is default-collapsed on first visit.
// Expand it explicitly so the paginated section actually renders.
function expandSections(): void {
  localStorage.setItem(COLLAPSED_KEY, "[]");
}

function provider(providerId: string, overrides: Partial<ProviderResponse> = {}): ProviderResponse {
  return {
    providerId,
    serviceKinds: ["llm"],
    displayName: providerId,
    enabled: true,
    isBuiltIn: true,
    configured: true,
    requiresAccount: true,
    hasAdapterUserAgent: false,
    supportsWebSearch: false,
    supportsModelDiscovery: true,
    routeIdentityVersions: { codex: "1", claude: "1" },
    ...overrides,
  };
}

// Twelve built-in providers that all land in "Other API Key Providers"
// (not founding/free-limited/well-known/OAuth), so one section has >8 cards.
const CATALOG: readonly ProviderResponse[] = Array.from({ length: 12 }, (_unused, index) =>
  provider(`p${String(index + 1).padStart(2, "0")}`, { displayName: `Provider ${index + 1}` }),
);

const seed = [
  { key: queryKeys.providers.all, data: CATALOG },
  {
    key: queryKeys.inferhub.summary,
    data: {
      models: [],
      providers: [],
      pricingConfig: null,
      meta: { fetchedAt: 0, ageSeconds: 0, stale: false },
      error: null,
    },
  },
];

function visibleIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll('a[href*="/providers/"]')]
    .map((el) => el.getAttribute("href") ?? "")
    .map((href) => href.split("/providers/")[1]?.split(/[?#]/)[0] ?? "")
    .filter(Boolean);
}

function toggleButton(container: HTMLElement): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) =>
    /show all|paginated/i.test(b.textContent ?? ""),
  );
}

async function clickToggle(container: HTMLElement): Promise<void> {
  const button = toggleButton(container);
  if (!button) throw new Error("Show All/Paginated toggle not rendered");
  button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function paginationControls(container: HTMLElement): Element | null {
  return container.querySelector('[data-testid^="providers-section-pagination-"]');
}

describe("ProvidersPage — section pagination", () => {
  afterEach(() => {
    localStorage.removeItem(DISPLAY_MODE_KEY);
  });

  test("renders 8 of 12 cards with pagination by default", async () => {
    expandSections();
    const view = await mount(createElement(Providers), { seed });
    await view.flush();

    const ids = visibleIds(view.container);
    expect(ids).toHaveLength(8);
    expect(toggleButton(view.container)?.textContent?.trim()).toBe("Show All");
    expect(paginationControls(view.container)).not.toBeNull();

    view.unmount();
  });

  test("Show All renders every card and hides pagination, then Paginated restores it", async () => {
    expandSections();
    const view = await mount(createElement(Providers), { seed });
    await view.flush();

    await view.act(() => clickToggle(view.container));
    await view.flush();

    expect(visibleIds(view.container)).toHaveLength(12);
    expect(toggleButton(view.container)?.textContent?.trim()).toBe("Paginated");
    expect(paginationControls(view.container)).toBeNull();

    await view.act(() => clickToggle(view.container));
    await view.flush();

    expect(visibleIds(view.container)).toHaveLength(8);
    expect(toggleButton(view.container)?.textContent?.trim()).toBe("Show All");
    expect(paginationControls(view.container)).not.toBeNull();

    view.unmount();
  });

  test("restores Show All preference after remount", async () => {
    expandSections();
    localStorage.removeItem(DISPLAY_MODE_KEY);
    const firstView = await mount(createElement(Providers), { seed });
    await firstView.flush();
    await firstView.act(() => clickToggle(firstView.container));
    await firstView.flush();

    expect(visibleIds(firstView.container)).toHaveLength(12);
    expect(localStorage.getItem(DISPLAY_MODE_KEY)).toBe("all");
    firstView.unmount();

    const secondView = await mount(createElement(Providers), { seed });
    await secondView.flush();
    expect(visibleIds(secondView.container)).toHaveLength(12);
    expect(toggleButton(secondView.container)?.textContent?.trim()).toBe("Paginated");
    expect(paginationControls(secondView.container)).toBeNull();
    secondView.unmount();
  });
});
