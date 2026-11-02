/**
 * P2-14: `anthropicCacheControl` maps every canonical cache hint shape to the
 * same top-level control. The hint parameter stays for call-site intent, but
 * it must not branch behavior — breakpoint handling lives in the surface
 * adapter.
 */
import { describe, expect, test } from "bun:test";
import { anthropicCacheControl } from "../../src/protocol/translation/cache-controls";

describe("anthropicCacheControl", () => {
  test("no hint still emits Anthropic's automatic ephemeral control", () => {
    expect(anthropicCacheControl(undefined)).toEqual({ cache_control: { type: "ephemeral" } });
  });

  test("stable_prefix hint yields the identical control", () => {
    expect(anthropicCacheControl("stable_prefix")).toEqual({
      cache_control: { type: "ephemeral" },
    });
  });

  test("breakpoint hint yields the identical control (per-block handling is the adapter's)", () => {
    expect(anthropicCacheControl({ kind: "breakpoint", list: [0] })).toEqual({
      cache_control: { type: "ephemeral" },
    });
  });

  test("the ttl option is honored on every shape", () => {
    expect(anthropicCacheControl(undefined, { ttl: "1h" })).toEqual({
      cache_control: { type: "ephemeral", ttl: "1h" },
    });
  });
});
