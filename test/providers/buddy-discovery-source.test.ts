/**
 * Buddy model discovery's source of truth.
 *
 * Both reference gateways call `/v3/config` and treat the personal-models path
 * as the narrower fallback. This repo only ever called the latter, so the
 * config path is added *ahead* of it. Discovery now fetches BOTH catalog
 * scopes and merges them (dedupe by model id) — mirroring the upstream
 * codebuddy2api catalog aggregation — so a host that answers both publishes the
 * union, and a host answering only one behaves exactly as before.
 */
import { describe, expect, test } from "bun:test";
import {
  BUDDY_CONFIG_PATH,
  BUDDY_CN_MODELS_PATH,
  BUDDY_INTL_MODELS_PATH,
  fetchBuddyDirectoryModels,
} from "../../src/providers/integrations/buddy/catalog";

const CATALOG = {
  code: 0,
  data: {
    models: [
      { id: "glm-5.2", name: "GLM 5.2", maxInputTokens: 200_000, maxOutputTokens: 128_000 },
      { id: "gpt-6-astra", name: "GPT-6 Astra", maxInputTokens: 400_000, maxOutputTokens: 32_000 },
    ],
  },
};

/** Personal-path catalog that carries a model absent from the shared catalog. */
const PERSONAL_CATALOG = {
  code: 0,
  data: {
    models: [
      { id: "glm-5.2", name: "GLM 5.2", maxInputTokens: 200_000, maxOutputTokens: 128_000 },
      { id: "personal-only-model", name: "Personal Only", maxInputTokens: 64_000, maxOutputTokens: 16_000 },
    ],
  },
};

/** Records each requested URL and answers with the per-path payload. */
function recordingFetcher(allowed: readonly string[]) {
  const calls: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    const raw = String(url);
    calls.push(raw);
    const ok = allowed.some((path) => raw.includes(path));
    const body = raw.includes(BUDDY_CONFIG_PATH) ? CATALOG : PERSONAL_CATALOG;
    return new Response(JSON.stringify(body), {
      status: ok ? 200 : 503,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

const base = {
  siteUrl: "https://www.codebuddy.ai/v2",
  providerId: "cb",
  credential: "token",
  endpoint: "/chat/completions",
};

describe("buddy model discovery", () => {
  test("fetches /v3/config and the personal-models path, merging the union", async () => {
    const { calls, fetcher } = recordingFetcher([BUDDY_CONFIG_PATH, BUDDY_INTL_MODELS_PATH]);
    const models = await fetchBuddyDirectoryModels({
      ...base,
      modelsPath: BUDDY_INTL_MODELS_PATH,
      fetcher,
    });
    // Shared glm-5.2 (deduped) + gpt-6-astra from config + personal-only model.
    expect(models?.length).toBe(3);
    expect(models?.map((model) => model.modelId)).toContain("personal-only-model");
    expect(calls.length).toBe(2);
    expect(calls[0]).toContain(BUDDY_CONFIG_PATH);
    expect(calls[1]).toContain(BUDDY_INTL_MODELS_PATH);
  });

  test("falls back to the personal-models path when config is unanswered", async () => {
    const { calls, fetcher } = recordingFetcher([BUDDY_INTL_MODELS_PATH]);
    const models = await fetchBuddyDirectoryModels({
      ...base,
      modelsPath: BUDDY_INTL_MODELS_PATH,
      fetcher,
    });
    expect(models?.length).toBe(2);
    expect(models?.map((model) => model.modelId)).toContain("personal-only-model");
    expect(calls.length).toBe(2);
    expect(calls[0]).toContain(BUDDY_CONFIG_PATH);
    expect(calls[1]).toContain(BUDDY_INTL_MODELS_PATH);
  });

  test("returns null when neither path answers", async () => {
    const { fetcher } = recordingFetcher([]);
    expect(
      await fetchBuddyDirectoryModels({ ...base, modelsPath: BUDDY_INTL_MODELS_PATH, fetcher }),
    ).toBeNull();
  });

  test("the CN provider asks the CN path, not the international one", async () => {
    // The CN host answers `/console/…`; the international path on it answers
    // 500 from the edge rather than 404, which reads as an upstream outage.
    const { calls, fetcher } = recordingFetcher([BUDDY_CN_MODELS_PATH]);
    const models = await fetchBuddyDirectoryModels({
      siteUrl: "https://copilot.tencent.com/v2",
      providerId: "cbcn",
      credential: "token",
      modelsPath: BUDDY_CN_MODELS_PATH,
      endpoint: "/chat/completions",
      fetcher,
    });
    expect(models?.length).toBe(2);
    expect(calls.some((url) => url.includes(BUDDY_CN_MODELS_PATH))).toBe(true);
    expect(calls.some((url) => url.includes(BUDDY_INTL_MODELS_PATH))).toBe(false);
  });

  test("the config payload's model list is what gets published", async () => {
    // `gpt-6-astra` is in the live `/v3/config` snapshot but absent from the
    // bundled catalog today, so discovery is what surfaces it.
    const { fetcher } = recordingFetcher([BUDDY_CONFIG_PATH]);
    const models = await fetchBuddyDirectoryModels({
      ...base,
      modelsPath: BUDDY_INTL_MODELS_PATH,
      fetcher,
    });
    expect(models?.map((model) => model.modelId)).toContain("gpt-6-astra");
  });
});
