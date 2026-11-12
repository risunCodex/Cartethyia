/**
 * Pro-only flags live on the international CodeBuddy model roster. The CN realm
 * does not inherit these international tags.
 *
 * The test pins the realm split at `makeBuddyModel`. It is a unit over the
 * shared helper because that is where the conditioning lives; the intl-only
 * guarantee must hold regardless of how discovery or seeding later changes.
 */
import { describe, expect, test } from "bun:test";
import { CODEBUDDY_MODELS } from "../../src/providers/integrations/buddy/codebuddy/index";
import { CODEBUDDY_CN_MODELS } from "../../src/providers/integrations/buddy/codebuddy/index";

describe("Buddy Pro-only tagging follows measured account scope", () => {
  test("none of the CN roster rows carry proOnly", () => {
    // `proOnly === true` is the only known refusal. absence means tier unknown,
    // and "the intl roster says free" must not propagate to CN.
    const leaky = CODEBUDDY_CN_MODELS.filter((row) => row.proOnly === true);
    expect(leaky).toEqual([]);
  });

  test("CodeBuddy international publishes the expected Pro-only model ids", () => {
    const codeBuddyProIds = new Set(
      CODEBUDDY_MODELS.filter((row) => row.proOnly === true).map((row) => row.modelId),
    );
    const expected = new Set([
      "primary-model",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-6-luna",
      "gpt-6-sol",
      "gpt-6.1-sol",
      "gpt-5.5",
      "gpt-5.4",
      "gemini-3.5-flash",
      "gemini-3.8-flash",
      "grok-4.6",
      "grok-4.7",
      "kimi-k3.1-pro-highspeed",
      // Opus is refused on free while Sonnet 4.6 at the same 1M window is
      // served, so the tier is not a function of the context size.
      "claude-opus-4.6",
      "claude-opus-4.7-1m",
    ]);
    expect(codeBuddyProIds).toEqual(expected);
  });
});
