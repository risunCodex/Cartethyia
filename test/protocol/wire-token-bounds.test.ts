// Output-token bounds across the three wire families.
//
// The contract under test: every wire leaves the caller's stated limit alone,
// and every wire sends a real number when the caller states none. The second
// half is the load-bearing one — an omitted limit used to be forwarded as an
// absent field, which upstreams that require the field reject outright.
import { describe, expect, test } from "bun:test";
import { canonicalToChatPayload } from "../../src/protocol/request/chat";
import { canonicalToResponsesPayload } from "../../src/protocol/request/responses";
import { canonicalToClaudeMessagesPayload } from "../../src/protocol/request/messages";
import { WIRE_TOKEN_BOUNDS } from "../../src/protocol/translation/quirks";
import type { CanonicalRequest } from "../../src/protocol/canonical-model";

function request(controls: Record<string, unknown>): CanonicalRequest {
  return {
    model: "deepseek-v4.1-flash",
    messages: [{ role: "user", content: [{ kind: "text", text: "hello" }] }],
    generation_controls: controls as CanonicalRequest["generation_controls"],
    stream: false,
    source_surface: "chat",
  };
}

describe("output-token bounds — the caller's stated limit is never invented over", () => {
  test("chat forwards a stated limit verbatim", () => {
    expect(canonicalToChatPayload(request({ max_tokens: 5_000 }))["max_tokens"]).toBe(5_000);
  });

  test("chat emits only its selected token-limit field", () => {
    const fromCompletionTokens = canonicalToChatPayload(request({ max_completion_tokens: 5_000 }));
    expect(fromCompletionTokens["max_tokens"]).toBe(5_000);
    expect(fromCompletionTokens).not.toHaveProperty("max_completion_tokens");

    const withBothAliases = canonicalToChatPayload(request({
      max_tokens: 5_000,
      max_completion_tokens: 5_000,
    }));
    expect(withBothAliases["max_tokens"]).toBe(5_000);
    expect(withBothAliases).not.toHaveProperty("max_completion_tokens");

    const completionTokenField = canonicalToChatPayload(
      request({ max_tokens: 5_000, max_completion_tokens: 5_000 }),
      { tokenLimitField: "max_completion_tokens" },
    );
    expect(completionTokenField["max_completion_tokens"]).toBe(5_000);
    expect(completionTokenField).not.toHaveProperty("max_tokens");
  });

  test("responses forwards a stated limit verbatim", () => {
    expect(canonicalToResponsesPayload(request({ max_tokens: 5_000 }))["max_output_tokens"]).toBe(
      5_000,
    );
  });

  test("responses normalizes aliases to a single output-token field", () => {
    const payload = canonicalToResponsesPayload(request({
      max_tokens: 5_000,
      max_completion_tokens: 5_000,
    }));
    expect(payload["max_output_tokens"]).toBe(5_000);
    expect(payload).not.toHaveProperty("max_tokens");
    expect(payload).not.toHaveProperty("max_completion_tokens");
  });

  test("responses requests a detailed summary when reasoning effort is set", () => {
    const payload = canonicalToResponsesPayload({
      ...request({}),
      reasoning: { effort: "high" },
    });
    expect(payload["reasoning"]).toEqual({ effort: "high", summary: "detailed" });
  });

  test("responses honors an explicit summary preference over the default", () => {
    const payload = canonicalToResponsesPayload({
      ...request({}),
      reasoning: { effort: "high", summary_mode: "concise" },
    });
    expect(payload["reasoning"]).toEqual({ effort: "high", summary: "concise" });
  });

  test("responses does not invent reasoning when no effort or summary is requested", () => {
    const payload = canonicalToResponsesPayload(request({}));
    expect(payload).not.toHaveProperty("reasoning");
  });

  test("chat forwards a limit above the old global ceiling", () => {
    expect(canonicalToChatPayload(request({ max_tokens: 128_000 }))["max_tokens"]).toBe(128_000);
  });

  test("chat clamps to the catalog output limit when one is supplied", () => {
    expect(canonicalToChatPayload(request({ max_tokens: 500_000 }), { maxOutputTokens: 384_000 })["max_tokens"]).toBe(384_000);
  });

  test("chat floors a limit below the wire minimum", () => {
    const floor = WIRE_TOKEN_BOUNDS["chat"]?.minTokens;
    expect(floor).toBeDefined();
    expect(canonicalToChatPayload(request({ max_tokens: 2 }))["max_tokens"]).toBe(floor);
  });
});

describe("an omitted limit still reaches the upstream as a number", () => {
  // PROVEN, not assumed: a 3.16M-char prompt to WorkBuddy/CodeBuddy
  // (`bansos/deepseek-v4.1-flash`) answered `400 model_param_invalid` on every
  // replay while `max_tokens` was absent, and answered 200 with the identical
  // body plus any explicit value — 1, 16, 1000, 8000, 64000, 384000 all passed.
  // So what the upstream rejects is the ABSENT FIELD, not its magnitude, and a
  // caller that expressed no limit must not be forwarded as one.

  test("chat sends a default rather than omitting the field", () => {
    const value = canonicalToChatPayload(request({}))["max_tokens"];
    expect(typeof value).toBe("number");
    expect(value).toBe(WIRE_TOKEN_BOUNDS["chat"]?.defaultMaxTokens);
  });

  test("responses sends a default rather than omitting the field", () => {
    const value = canonicalToResponsesPayload(request({}))["max_output_tokens"];
    expect(typeof value).toBe("number");
    expect(value).toBe(WIRE_TOKEN_BOUNDS["responses"]?.defaultMaxTokens);
  });

  test("messages sends its own default rather than omitting the field", () => {
    // Anthropic has always required the field; this is the behavior the other
    // two wires were brought in line with.
    const value = canonicalToClaudeMessagesPayload(request({}))["max_tokens"];
    expect(typeof value).toBe("number");
    expect(value).toBe(WIRE_TOKEN_BOUNDS["messages"]?.defaultMaxTokens);
  });

  test("every wire that declares a bound resolves one when the caller is silent", () => {
    // The regression guard: a wire added later must not silently forward an
    // absent limit while its siblings send a default.
    for (const [wire, bound] of Object.entries(WIRE_TOKEN_BOUNDS)) {
      expect(bound.defaultMaxTokens, `${wire} must declare a default`).toBeDefined();
    }
  });
});
