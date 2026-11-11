import { describe, expect, test } from "bun:test";
import { fetchVercelQuota } from "../../src/providers/integrations/vercel/vercel-quota";
import { VERCEL_DEFAULT_MODELS } from "../../src/providers/integrations/vercel/provider";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Vercel AI Gateway quota", () => {
  test("reads the pooled credit balance and total spend", async () => {
    const fetcher = (async () => jsonResponse({ balance: "5", token_pass: null, total_used: "0.0000108" })) as unknown as typeof fetch;
    const result = await fetchVercelQuota("vck_test", fetcher);
    expect(result.source).toBe("vercel");
    expect(result.error).toBeNull();
    expect(result.windows).toHaveLength(1);
    const window = result.windows[0]!;
    expect(window.kind).toBe("credits");
    expect(window.accounting).toBe("pooled");
    expect(window.remaining).toBe(5);
    expect(window.used).toBe(0.0000108);
    expect(window.limit).toBeNull();
    expect(window.usedPercent).toBeNull();
  });

  test("returns no usable numbers as an unavailable result", async () => {
    const fetcher = (async () => jsonResponse({})) as unknown as typeof fetch;
    const result = await fetchVercelQuota("vck_test", fetcher);
    expect(result.windows).toEqual([]);
    expect(result.error).toContain("no usable numbers");
  });

  test("a failed read becomes a null result, not a throw", async () => {
    const fetcher = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const result = await fetchVercelQuota("vck_test", fetcher);
    expect(result.windows).toEqual([]);
    expect(result.error).toBeTruthy();
  });
});

describe("Vercel AI Gateway default roster", () => {
  test("seeds the free nemotron row plus the two billed picks", () => {
    expect(VERCEL_DEFAULT_MODELS).toHaveLength(3);
    const ids = new Set(VERCEL_DEFAULT_MODELS.map((model) => model.modelId));
    expect(ids).toEqual(
      new Set([
        "nvidia/nemotron-3.5-lightning-free",
        "meituan/longcat-2.5",
        "inception/mercury-3",
      ]),
    );
  });

  test("only the nemotron row is free-tier", () => {
    const nemotron = VERCEL_DEFAULT_MODELS.find(
      (model) => model.modelId === "nvidia/nemotron-3.5-lightning-free",
    )!;
    expect(nemotron.freeTier).toBe(true);
    expect(nemotron.proOnly).toBeUndefined();
    expect(nemotron.cost.input).toBe(0);
    expect(nemotron.cost.output).toBe(0);
    const billed = VERCEL_DEFAULT_MODELS.filter(
      (model) => model.modelId !== "nvidia/nemotron-3.5-lightning-free",
    );
    expect(billed).toHaveLength(2);
    for (const model of billed) {
      expect(model.freeTier).toBeUndefined();
      expect(model.proOnly).toBeUndefined();
    }
  });

  test("the billed rows carry the capabilities the upstream declares", () => {
    const longcat = VERCEL_DEFAULT_MODELS.find((model) => model.modelId === "meituan/longcat-2.5")!;
    expect(longcat.modalities.input).toContain("image");
    expect(longcat.reasoning).toBe(true);
    expect(longcat.toolCall).toBe(true);
    expect(longcat.contextLimit).toBe(1_048_576);
    expect(longcat.outputLimit).toBe(131_072);

    const mercury = VERCEL_DEFAULT_MODELS.find((model) => model.modelId === "inception/mercury-3")!;
    expect(mercury.reasoning).toBe(true);
    expect(mercury.toolCall).toBe(true);
    expect(mercury.contextLimit).toBe(1_000_000);
    expect(mercury.outputLimit).toBe(131_072);
  });
});
