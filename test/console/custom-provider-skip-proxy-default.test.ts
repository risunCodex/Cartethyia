/**
 * A custom compatible provider starts with proxying skipped.
 *
 * `DEFAULT_PROXY_SKIP_PROVIDER_IDS` is built from the *bundled* catalog
 * (`defaultSkipProxy` in provider metadata), so it can only ever contain ids
 * that shipped with the gateway. A custom OpenAI-/Anthropic-compatible
 * provider picks its id at creation time and is therefore absent from that set
 * — every one of them started with `skipProxy: false`, even though the flag
 * exists precisely for an operator's own endpoint reached by a compatible
 * client.
 *
 * The custom case is decided by "not bundled", the same test the create path
 * already uses to reject a reserved slug. Bundled providers are untouched:
 * their opt-in metadata still decides, and one that did not opt in stays
 * proxied.
 *
 * This is only the initial value — an explicit `skipProxy` in a patch always
 * wins, so an operator who turned proxying back on keeps it on.
 */
import { describe, expect, test } from "bun:test";
import { defaultSkipProxy } from "../../src/console/providers/detail/store";
import { isBundledProviderId } from "../../src/providers/provider-contracts";
import { DEFAULT_PROXY_SKIP_PROVIDER_IDS } from "../../src/providers/provider-metadata";

describe("custom compatible provider default", () => {
  test("a custom openai-compatible provider skips the proxy", () => {
    // The reported case: "Add Custom OpenAI Provider" then no proxy wanted.
    expect(isBundledProviderId("oc-prod")).toBe(false);
    expect(defaultSkipProxy("oc-prod")).toBe(true);
  });

  test("a custom anthropic-compatible provider skips the proxy", () => {
    expect(defaultSkipProxy("ac-prod")).toBe(true);
  });

  test("any id that is not bundled skips the proxy", () => {
    // Not a hardcoded list: custom ids are chosen at creation time, so the
    // rule has to follow "not bundled" rather than a second catalogue.
    for (const id of ["mine", "internal-llm", "oc-prod-2", "zzz"]) {
      expect(defaultSkipProxy(id)).toBe(true);
    }
  });
});

describe("bundled providers are untouched", () => {
  test("a bundled provider that opted in still skips", () => {
    for (const id of DEFAULT_PROXY_SKIP_PROVIDER_IDS) {
      expect(defaultSkipProxy(id)).toBe(true);
    }
  });

  test("a bundled provider that did not opt in still uses the proxy", () => {
    // The regression that matters: routing through the proxy is the working
    // setup for these, and it must not change.
    for (const id of ["cb", "openai"]) {
      expect(isBundledProviderId(id)).toBe(true);
      expect(defaultSkipProxy(id)).toBe(false);
    }
  });
});
