import { describe, expect, test } from "bun:test";
import { OAuthDeviceFlow } from "../../src/providers/authentication/oauth-device-flow";
import type { OAuthDeviceFlowContext } from "../../src/providers/authentication/oauth-flow-store";
import { skipGithubAccountPicker } from "../../src/providers/authentication/oauth-flow-store";

/** A minimal concrete device-flow client exposing the protected `fetchFor`. */
class ExposedClient extends OAuthDeviceFlow {
  protected override readonly providerLabel = "test";
  protected override readonly clientId = "cid";
  protected override readonly tokenUrl = "https://token.test";
  protected override readonly scopes = "";
  override readonly supportsDeviceCode = true;
  override readonly supportsBrowserCode = false;

  resolveFor(context?: OAuthDeviceFlowContext) {
    return this.fetchFor(context);
  }
}

describe("OAuthDeviceFlow.fetchFor", () => {
  test("uses the flow context's injected fetch when present", () => {
    const client = new ExposedClient(async () => new Response());
    const contextual = async () => new Response("via-context");
    const resolved = client.resolveFor({
      providerId: "x",
      tenantId: null,
      accountLabel: "x",
      fetchFn: contextual,
    });
    expect(resolved).toBe(contextual);
  });

  test("falls back to the client's own fetch without a context override", () => {
    const own = async () => new Response("own");
    const client = new ExposedClient(own);
    expect(client.resolveFor()).toBe(own);
    // A context without a fetchFn also keeps the client fetch.
    expect(client.resolveFor({ providerId: "x", tenantId: null, accountLabel: "x" })).toBe(own);
  });
});

describe("skipGithubAccountPicker", () => {
  test("adds skip_account_picker to GitHub's device page", () => {
    expect(skipGithubAccountPicker("https://github.com/login/device")).toBe(
      "https://github.com/login/device?skip_account_picker=true",
    );
  });

  test("is idempotent and preserves other query params", () => {
    expect(skipGithubAccountPicker("https://github.com/login/device?skip_account_picker=true")).toBe(
      "https://github.com/login/device?skip_account_picker=true",
    );
    expect(skipGithubAccountPicker("https://github.com/login/device?foo=bar")).toBe(
      "https://github.com/login/device?foo=bar&skip_account_picker=true",
    );
  });

  test("leaves every non-GitHub-device URI untouched", () => {
    // GitHub Enterprise hosts, other GitHub paths, and other providers' device
    // pages are not GitHub's account-picker page.
    for (const uri of [
      "https://ghe.example.com/login/device",
      "https://github.com/login/oauth/authorize",
      "https://auth.openai.com/codex/device",
      "https://qoder.com/device/selectAccounts",
      "not a url",
    ]) {
      expect(skipGithubAccountPicker(uri)).toBe(uri);
    }
  });
});
