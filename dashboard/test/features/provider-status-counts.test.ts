/**
 * Provider-card status badges, against the new list-item overview shape.
 *
 * Cards no longer fetch accounts/models per provider — they render straight
 * from the `GET /console/api/providers` list fields (`accountCount` /
 * `activeAccountCount` / `modelCount`). This suite mounts the real page with a
 * seeded catalog carrying those fields and asserts the badge text, so a card
 * that reads the wrong field (or still tries to fetch) fails here.
 *
 * It also pins the G-05 d1 lazy-mount gate: the largest section ("Other API
 * Key Providers") is collapsed on first visit, so its cards are not mounted
 * until the operator expands it.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createElement } from "react";
import { mount } from "../helpers/render";
import { registerDom } from "../helpers/dom";
import Providers from "../../src/features/providers/ProvidersPage";
import { queryKeys } from "../../src/data/query-keys";
import type { ProviderResponse } from "../../src/data/contracts";

// Bun evaluates imports before any hook, and `beforeEach` touches
// `localStorage`, so the DOM has to be installed at module scope.
registerDom();

const COLLAPSED_KEY = "cartethyia.providerSectionsCollapsed";

function provider(
  providerId: string,
  overrides: Partial<ProviderResponse> = {},
): ProviderResponse {
  return {
    providerId,
    serviceKinds: ["llm"],
    displayName: providerId,
    enabled: true,
    isBuiltIn: true,
    configured: false,
    requiresAccount: true,
    hasAdapterUserAgent: false,
    supportsWebSearch: false,
    supportsModelDiscovery: true,
    routeIdentityVersions: { codex: "1", claude: "1" },
    ...overrides,
  };
}

/** The InferHub marketplace summary the page's sibling sections may read. */
const INFERHUB_SEED = {
  key: queryKeys.inferhub.summary,
  data: {
    models: [],
    providers: [],
    pricingConfig: null,
    meta: { fetchedAt: 0, ageSeconds: 0, stale: false },
    error: null,
  },
};

function visibleIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll('a[href*="/providers/"]')]
    .map((el) => el.getAttribute("href") ?? "")
    .map((href) => href.split("/providers/")[1]?.split(/[?#]/)[0] ?? "")
    .filter(Boolean);
}

describe("provider card badges from the list overview fields", () => {
  beforeEach(() => {
    localStorage.removeItem(COLLAPSED_KEY);
  });
  afterEach(() => {
    localStorage.removeItem(COLLAPSED_KEY);
  });

  test("renders Healthy/Unhealthy connection badges and the model badge from the overview fields", async () => {
    const CATALOG = [
      // All accounts active → one Healthy badge.
      provider("anthropic", { configured: true, accountCount: 3, activeAccountCount: 3, modelCount: 5 }),
      // Mixed: 1 of 3 routable → Healthy + Unhealthy.
      provider("openai", { configured: true, accountCount: 3, activeAccountCount: 1, modelCount: 2 }),
      // No accounts at all.
      provider("mistral", { configured: true, accountCount: 0, modelCount: 0 }),
      // Credential-less provider: no accounts by design, not omission.
      provider("opencode", { requiresAccount: false, accountCount: 0, modelCount: 0 }),
    ];
    const view = await mount(createElement(Providers), {
      seed: [{ key: queryKeys.providers.all, data: CATALOG }, INFERHUB_SEED],
    });
    await view.flush();

    const text = view.container.textContent ?? "";
    expect(text).toContain("3 Healthy");
    expect(text).toContain("5 models");
    expect(text).toContain("1 Healthy");
    expect(text).toContain("2 Unhealthy");
    expect(text).toContain("2 models");
    expect(text).toContain("No connections");
    expect(text).toContain("No models");
    expect(text).toContain("Free Endpoint");
    view.unmount();
  });

  test("shows a Disabled corner ribbon when the provider is parked, and keeps Friend only while enabled", async () => {
    const CATALOG = [
      // Founding sponsor, still live → Friend ribbon.
      provider("inferhub", {
        configured: true,
        accountCount: 1,
        activeAccountCount: 1,
        modelCount: 1,
      }),
      // Disabled builtin → Disabled ribbon, no Friend.
      provider("anthropic", {
        enabled: false,
        configured: true,
        accountCount: 2,
        activeAccountCount: 2,
        modelCount: 3,
      }),
    ];
    const view = await mount(createElement(Providers), {
      seed: [{ key: queryKeys.providers.all, data: CATALOG }, INFERHUB_SEED],
    });
    await view.flush();

    const friend = view.container.querySelector('[aria-label="Friend sponsor"]');
    expect(friend).toBeTruthy();
    expect(friend?.textContent?.trim()).toBe("Friend");

    const disabled = view.container.querySelector('[aria-label="Provider disabled"]');
    expect(disabled).toBeTruthy();
    expect(disabled?.textContent?.trim()).toBe("Disabled");
    view.unmount();

    // A disabled founding provider must read as Disabled, not Friend — otherwise
    // the operator forgets why the sponsor route stopped answering.
    const parked = await mount(createElement(Providers), {
      seed: [
        {
          key: queryKeys.providers.all,
          data: [
            provider("inferhub", {
              enabled: false,
              configured: true,
              accountCount: 1,
              activeAccountCount: 1,
              modelCount: 1,
            }),
          ],
        },
        INFERHUB_SEED,
      ],
    });
    await parked.flush();
    expect(parked.container.querySelector('[aria-label="Friend sponsor"]')).toBeNull();
    expect(parked.container.querySelector('[aria-label="Provider disabled"]')).toBeTruthy();
    parked.unmount();
  });

  test("default-collapses Other API Key Providers and mounts its cards only when expanded", async () => {
    const OTHER = provider("oddball", {
      configured: true,
      accountCount: 4,
      activeAccountCount: 2,
      modelCount: 3,
    });
    const view = await mount(createElement(Providers), {
      seed: [{ key: queryKeys.providers.all, data: [OTHER] }, INFERHUB_SEED],
    });
    await view.flush();

    // First visit: the largest section stays collapsed, so its cards are not
    // mounted at all — a lightweight placeholder (the header) is all that
    // exists for it.
    expect(visibleIds(view.container)).not.toContain("oddball");

    const header = [...view.container.querySelectorAll("button")].find((button) =>
      /Other API Key Providers/.test(button.textContent ?? ""),
    );
    expect(header).toBeTruthy();
    await view.act(() => {
      header!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await view.flush();

    expect(visibleIds(view.container)).toContain("oddball");
    const text = view.container.textContent ?? "";
    expect(text).toContain("2 Healthy");
    expect(text).toContain("2 Unhealthy");
    expect(text).toContain("3 models");
    view.unmount();
  });
});
