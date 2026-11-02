/**
 * Command Code serves three wires, and the adapter used to force all of them
 * onto one.
 *
 * The Provider API answers `/chat/completions`, `/responses` and `/messages`.
 * Every `claude-*` id is served on `/messages` only — filed as chat, all nine
 * were posted to an endpoint that does not answer them, so they could never be
 * dispatched. The adapter also rejected any non-chat candidate outright, which
 * made the failure explicit rather than silent.
 *
 * The wire is chosen from the provider's own `supported_endpoints`, so it is
 * advertised rather than guessed from the id.
 *
 * `:free` is not a free tier on this provider. Verified against the live API:
 * `minimax/minimax-m3.1-flash-preview:free`, `stealth/cat-jam:free`,
 * `stealth/glyph-cluster:free` and `reflection/beam:free` all answer 400
 * "insufficient credits" on an account whose `freeCredits` is 0 — the opposite
 * of OpenRouter, Kilo and Cline, where the suffix is the tier.
 */
import { describe, expect, test } from "bun:test";
import { commandCodeWireFor, discoverCommandCodeModels } from "../../src/providers/integrations/commandcode/discovery";
import {
  COMMANDCODE_GENERATE_PATH,
  COMMANDCODE_MODELS,
} from "../../src/providers/integrations/commandcode/commandcode";

describe("commandCodeWireFor", () => {
  test("a claude id is served on the messages wire", () => {
    // This is the whole gap: filed as chat, these were unroutable.
    expect(commandCodeWireFor("claude-sonnet-5-5")).toEqual({
      wireFamily: "messages",
      endpointPath: "/alpha/generate",
    });
  });

  test("a model advertising /responses is served on the responses wire", () => {
    expect(commandCodeWireFor("gpt-5.4-mini", ["/chat/completions", "/responses"])).toEqual({
      wireFamily: "responses",
      endpointPath: "/alpha/generate",
    });
  });

  test("a model advertising chat only keeps the chat wire", () => {
    // Chat is what every non-Claude model serves, so a listing that omits the
    // field never breaks.
    expect(commandCodeWireFor("stepfun/Step-3.5-Flash", ["/chat/completions"])).toEqual({
      wireFamily: "chat",
      endpointPath: "/alpha/generate",
    });
    expect(commandCodeWireFor("stepfun/Step-3.5-Flash")).toEqual({
      wireFamily: "chat",
      endpointPath: "/alpha/generate",
    });
  });

  test("the advertised wire is used even when a claude id lists responses", () => {
    // The prefix rule is unconditional: a claude id answers /messages only, so
    // an advertised /responses must not move it.
    expect(commandCodeWireFor("claude-opus-5", ["/responses"])).toEqual({
      wireFamily: "messages",
      endpointPath: "/alpha/generate",
    });
  });
});

describe("commandcode discovery", () => {
  test("each row carries the wire that serves it", async () => {
    const models = await discoverCommandCodeModels({
      baseUrl: "https://api.commandcode.ai/provider/v1",
      credential: "token",
      fetcher: (async () =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [
              { id: "claude-sonnet-5-5", context_length: 1000000, supported_endpoints: ["/messages"] },
              { id: "gpt-5.4-mini", context_length: 400000, supported_endpoints: ["/chat/completions", "/responses"] },
              { id: "stepfun/Step-3.5-Flash", context_length: 262144, supported_endpoints: ["/chat/completions"] },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
    });
    expect(models).not.toBeNull();
    const byId = new Map((models ?? []).map((m) => [m.modelId, m]));
    expect(byId.get("claude-sonnet-5-5")?.wireFamily).toBe("messages");
    expect(byId.get("claude-sonnet-5-5")?.endpointPath).toBe("/alpha/generate");
    expect(byId.get("gpt-5.4-mini")?.wireFamily).toBe("responses");
    expect(byId.get("stepfun/Step-3.5-Flash")?.wireFamily).toBe("chat");
    // The listing's context_length is carried, not the generic default.
    expect(byId.get("claude-sonnet-5-5")?.contextLimit).toBe(1000000);
  });

  test("no row is marked a free tier", async () => {
    // A `:free` id here is billed, so marking it would publish paid models as
    // free — the defect fixed on Cline.
    const models = await discoverCommandCodeModels({
      baseUrl: "https://api.commandcode.ai/provider/v1",
      credential: "token",
      fetcher: (async () =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [
              { id: "stealth/cat-jam:free", context_length: 1048576, supported_endpoints: ["/responses"] },
              { id: "poolside/laguna-s-2.1-free", context_length: 256000, supported_endpoints: ["/chat/completions"] },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as unknown as typeof fetch,
    });
    expect(models).not.toBeNull();
    expect(models?.length).toBe(2);
    for (const model of models ?? []) {
      expect(model.freeTier).toBeUndefined();
    }
  });

  test("a failed fetch is null, not an empty roster", async () => {
    // null is "could not be read" and [] is "the roster is empty"; conflating
    // them clears the provider's models on a transient failure.
    const models = await discoverCommandCodeModels({
      baseUrl: "https://api.commandcode.ai/provider/v1",
      credential: "token",
      fetcher: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
    });
    expect(models).toBeNull();
  });
});

describe("commandcode static catalog", () => {
  test("the roster carries all three wires", () => {
    const families = new Set(COMMANDCODE_MODELS.map((m) => m.wireFamily));
    expect(families.has("messages")).toBe(true);
    expect(families.has("responses")).toBe(true);
    expect(families.has("chat")).toBe(true);
  });

  test("every claude id is on the messages wire", () => {
    const claude = COMMANDCODE_MODELS.filter((m) => m.modelId.startsWith("claude-"));
    expect(claude.length).toBeGreaterThan(0);
    for (const model of claude) {
      expect(model.wireFamily).toBe("messages");
      expect(model.endpointPath).toBe("/alpha/generate");
    }
  });

  test("every row states a context window", () => {
    // The old catalog stated none, so routing fell back for every model.
    for (const model of COMMANDCODE_MODELS) {
      expect(model.contextLimit).toBeGreaterThan(0);
    }
  });

  test("every row dispatches to the CLI generate surface", () => {
    // The reference client sends all generation to `/alpha/generate` and does
    // not vary the path by the wire a model row declares, so no row may point
    // at a `/provider/v1/<wire>` route. Catalog wire metadata does not change
    // the proprietary CLI request or its NDJSON response.
    const paths = new Set(COMMANDCODE_MODELS.map((m) => m.endpointPath));
    expect(paths).toEqual(new Set([COMMANDCODE_GENERATE_PATH]));
  });

  test("no row is marked a free tier", () => {
    for (const model of COMMANDCODE_MODELS) {
      expect(model.freeTier).toBeUndefined();
    }
  });
});
