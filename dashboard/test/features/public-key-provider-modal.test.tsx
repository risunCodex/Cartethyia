/**
 * The "Public Key" switch in the Add Compatible Provider modal.
 *
 * happy-dom does not bridge React 19's synthetic `onChange` for a text input
 * (the same limitation `add-model-discovery.test.tsx` documents), so the
 * submit flow is asserted the way that suite does: the pure request-builder is
 * pinned directly, and the mutations are exercised through the real hooks with
 * a stubbed fetch. The rendered markup pins the switch's effect on the key
 * field, and the badge pins the row label.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { mount, renderMarkup } from "../helpers/render";
import { registerDom } from "../helpers/dom";
import {
  buildCompatibleProviderRequest,
  default as Providers,
} from "../../src/features/providers/ProvidersPage";
import { useCreateProvider, useCreateProviderAccount } from "../../src/hooks/providers";
import { queryKeys } from "../../src/data/query-keys";
import type { ProviderResponse } from "../../src/data/contracts";

beforeAll(() => {
  registerDom();
  const source = globalThis.window as unknown as Record<string, unknown>;
  const target = globalThis as unknown as Record<string, unknown>;
  for (const [name, value] of Object.entries(source)) {
    if (target[name] !== undefined) continue;
    try {
      Object.defineProperty(target, name, { value, writable: true, configurable: true });
    } catch {
      // A read-only accessor is already available to the component.
    }
  }
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function provider(providerId: string): ProviderResponse {
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
  };
}

interface FetchCall {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

function stubFetch(): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const raw = typeof init?.body === "string" ? init.body : "";
      let body: unknown = undefined;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      calls.push({ method, url, body });
      return Response.json({ ok: true });
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof globalThis.fetch;
  return calls;
}

function modalSeed(): readonly { readonly key: readonly unknown[]; readonly data: unknown }[] {
  return [
    { key: queryKeys.providers.all, data: [provider("anthropic")] },
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
}

describe("buildCompatibleProviderRequest", () => {
  test("public key sends requiresAccount: false", () => {
    const request = buildCompatibleProviderRequest({
      providerId: "howtofix",
      label: "HowToFix Public",
      baseUrl: "https://srv1.howtofix.id/v1",
      wireFamily: "chat",
      sendCliIdentity: true,
      publicKey: true,
      serviceKinds: undefined,
      extraHeaders: {},
    });
    expect(request).toMatchObject({
      providerId: "howtofix",
      baseUrl: "https://srv1.howtofix.id/v1",
      requiresAccount: false,
    });
  });

  test("a keyed provider leaves requiresAccount at the default", () => {
    const request = buildCompatibleProviderRequest({
      providerId: "howtofix-keyed",
      label: "HowToFix Keyed",
      baseUrl: "https://srv1.howtofix.id/v1",
      wireFamily: "chat",
      sendCliIdentity: true,
      publicKey: false,
      serviceKinds: undefined,
      extraHeaders: {},
    });
    expect(request).toMatchObject({ providerId: "howtofix-keyed" });
    // Absent, not `true`: the server's default is `true`, and the field is
    // only sent when the operator turned Public Key on.
    expect(request.requiresAccount).toBeUndefined();
  });
});

describe("Add Compatible Provider — Public Key", () => {
  test("the switch disables the API-key field", async () => {
    // `renderMarkup` cannot render the modal's portal, so the switch's effect
    // is pinned on the mounted tree instead: the dialog opens through the
    // page's own trigger and the field's disabled state follows the switch.
    const view = await mount(createElement(Providers), { seed: modalSeed() });
    await view.flush();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await view.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      if (document.querySelector("#add-compatible-provider")) break;
      await view.act(async () => {
        const button = [...view.container.querySelectorAll("button")].find((b) =>
          (b.textContent ?? "").includes("Custom OpenAI"),
        );
        button?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
    }
    try {
      const field = document.querySelector("#compat-credential") as HTMLInputElement | null;
      expect(field).not.toBeNull();
      expect(field?.disabled).toBe(false);
      const switchButton = document.querySelector("#compat-public-key") as HTMLButtonElement | null;
      expect(switchButton).not.toBeNull();
      await view.act(async () => {
        switchButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const disabled = document.querySelector("#compat-credential") as HTMLInputElement | null;
      expect(disabled?.disabled).toBe(true);
    } finally {
      view.unmount();
    }
  });

  test("public-key submit creates requiresAccount:false and the none account", async () => {
    const calls = stubFetch();
    const harness = () => {
      const create = useCreateProvider();
      const createAccount = useCreateProviderAccount();
      return createElement(
        "button",
        {
          id: "public-key-submit",
          onClick: () => {
            void (async () => {
              const req = buildCompatibleProviderRequest({
                providerId: "howtofix",
                label: "HowToFix Public",
                baseUrl: "https://srv1.howtofix.id/v1",
                wireFamily: "chat",
                sendCliIdentity: true,
                publicKey: true,
                serviceKinds: undefined,
                extraHeaders: {},
              });
              await create.mutateAsync(req);
              await createAccount.mutateAsync({
                providerId: "howtofix",
                request: { credentialKind: "none", label: "Public Key" },
              });
            })();
          },
        },
        "Submit public key",
      );
    };
    const view = await mount(createElement(harness), { seed: modalSeed() });
    await view.flush();
    await view.click("#public-key-submit");
    await view.flush();
    await view.flush();
    try {
      const create = calls.find((c) => c.method === "POST" && c.url.endsWith("/providers"));
      expect(create?.body).toMatchObject({
        providerId: "howtofix",
        baseUrl: "https://srv1.howtofix.id/v1",
        requiresAccount: false,
      });
      const account = calls.find((c) => c.method === "POST" && c.url.includes("/accounts"));
      // The account hook posts the request body directly to
      // `/providers/:id/accounts` (no envelope).
      expect(account?.url).toContain("/providers/howtofix/accounts");
      expect(account?.body).toMatchObject({ credentialKind: "none", label: "Public Key" });
    } finally {
      view.unmount();
    }
  });
});

describe("Public Key row labelling", () => {
  test("the account status badge names a credential-less account Public Key", () => {
    const markup = renderMarkup(
      createElement(
        require("../../src/features/provider-detail/sections/AccountStatusBadge").AccountStatusBadge,
        {
          account: {
            id: "acc-1",
            providerId: "howtofix",
            label: "Public Key",
            credentialKind: "none",
            status: "active",
            usageToday: { totalTokens: 0, requests: 0 },
            usageAllTime: { totalTokens: 0, requests: 0 },
          },
        },
      ),
    );
    expect(markup).toContain("Public Key");
  });
});
