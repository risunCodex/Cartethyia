import { defineModel } from "../../provider-model-definition";
import type { ModelDefinition } from "../../provider-model-definition";

/** Provider id this catalog belongs to. */
export const KIRO_PROVIDER_ID = "kiro" as const;

/**
 * The adapter's own RPC path. Kiro has no chat-shaped route: the endpoint is a
 * single `generateAssistantResponse` operation the adapter posts a conversation
 * ledger to, so the path is recorded here for catalog completeness rather than
 * selected by wire family.
 */
export const KIRO_GENERATE_PATH = "/generateAssistantResponse" as const;

/**
 *  Runtime service host template (generation). `{region}` is interpolated.
 *
 *  The 1.4.62 IDE targets the Kiro runtime service (`KiroRuntimeService`,
 *  apiVersion 2026-01-13) at `https://runtime.{region}.kiro.dev` instead of the
 *  legacy `q.{region}.amazonaws.com` AWS surface. Discovery/usage use the
 *  control-plane `management` host; generation uses `runtime`.
 */
export const KIRO_RUNTIME_HOST_TEMPLATE = "https://runtime.{region}.kiro.dev" as const;

/** Control-plane (management) service host template (models/usage). */
export const KIRO_MANAGEMENT_HOST_TEMPLATE = "https://management.{region}.kiro.dev" as const;

/**
 * Effort tiers the Kiro models that accept an effort field advertise.
 *
 * The upstream has no `minimal` or `max` tier on either schema, so the ladder
 * stops at `xhigh` and the builder maps the canonical extremes onto it.
 */
const KIRO_EFFORTS = ["low", "medium", "high", "xhigh"] as const;

/**
 * One Kiro model row.
 *
 * `ctx` and `out` are the model's real limits. Opus 5/4.8/4.7 and Sonnet 5/5.5
 * carry 1M context; the 4.5-era rows and both Haiku rows carry 200k. `auto`
 * routes upstream and is declared at 1M/32k.
 *
 * The non-Anthropic row is GLM 5 at 200k/64k. GPT 5.5 and the 5.6 rows keep
 * 272k/128k. DeepSeek V3.2, Qwen3 Coder Next, and MiniMax M2.5 are retired and
 * must not return through discovery.
 */
function kiroModel(options: {
  readonly id: string;
  readonly ctx: number;
  readonly out: number;
  readonly vision?: boolean;
  readonly reasoning?: boolean;
  readonly toolCall?: boolean;
  readonly webSearch?: boolean;
  /** Marks the row as served on the provider's free plan tier (the free pill). */
  readonly freeTier?: boolean;
}): ModelDefinition {
  return defineModel({
    id: options.id,
    providerId: KIRO_PROVIDER_ID,
    wireFamily: "chat",
    endpoint: KIRO_GENERATE_PATH,
    ctx: options.ctx,
    out: options.out,
    ...(options.vision === undefined ? {} : { vision: options.vision }),
    ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
    ...(options.toolCall === undefined ? {} : { toolCall: options.toolCall }),
    ...(options.webSearch === undefined ? {} : { webSearch: options.webSearch }),
    ...(options.freeTier === undefined ? {} : { freeTier: options.freeTier }),
    ...(options.reasoning ? { reasoningEfforts: KIRO_EFFORTS } : {}),
  });
}

/**
 * Offline seed catalog.
 *
 * The upstream's own model list is authoritative and is fetched at discovery
 * time; this row set is what a request can be routed to before that has ever
 * run, so it names the family the service is documented to serve rather than
 * guessing at what an individual account's plan reaches.
 */
export const KIRO_MODELS: readonly ModelDefinition[] = [
  // Free-tier rows (KIRO FREE plan): the models the free tier serves. Marked
  // `freeTier` so the model list groups them under the free pill like every
  // other provider's free roster; latency measured live 2026-11-02.
  kiroModel({ id: "auto", ctx: 1_000_000, out: 32_000, reasoning: true, toolCall: true, freeTier: true }),
  kiroModel({ id: "claude-haiku-4.5", ctx: 200_000, out: 64_000, vision: true, reasoning: true, toolCall: true, freeTier: true }),
  kiroModel({ id: "claude-sonnet-4.5", ctx: 200_000, out: 64_000, vision: true, reasoning: true, toolCall: true, freeTier: true }),
  kiroModel({ id: "glm-5", ctx: 200_000, out: 64_000, reasoning: true, toolCall: true, freeTier: true }),
  // Paid-tier rows (Pro).
  kiroModel({ id: "claude-opus-5", ctx: 1_000_000, out: 128_000, vision: true, reasoning: true, toolCall: true }),
  kiroModel({ id: "claude-opus-4.8", ctx: 1_000_000, out: 128_000, vision: true, reasoning: true, toolCall: true }),
  kiroModel({ id: "claude-opus-4.7", ctx: 1_000_000, out: 128_000, vision: true, reasoning: true, toolCall: true }),
  kiroModel({ id: "claude-opus-4.5", ctx: 200_000, out: 64_000, vision: true, reasoning: true, toolCall: true }),
  kiroModel({ id: "claude-sonnet-5", ctx: 1_000_000, out: 128_000, vision: true, reasoning: true, toolCall: true }),
  kiroModel({ id: "claude-sonnet-5.5", ctx: 1_000_000, out: 128_000, vision: true, reasoning: true, toolCall: true }),
  // 200K, not the 1M the 1M-window models use: Sonnet 4.5 predates it. The
  // million-token window arrived with Opus 4.6 and the 5.x generation; the 4.5
  // trio is 200K, and Opus and Haiku here already say so.
  // 1M/128K, not the 200K/64K of the 4.5 row above it: Haiku moved to the
  // million-token window and the doubled output ceiling with the rest of the
  // 5.x generation, and this line had been copied from its predecessor.
  kiroModel({ id: "claude-haiku-5.5", ctx: 1_000_000, out: 128_000, vision: true, reasoning: true, toolCall: true }),
  kiroModel({ id: "gpt-5.5", ctx: 272_000, out: 128_000, reasoning: true, toolCall: true }),
  kiroModel({ id: "gpt-5.6-sol", ctx: 272_000, out: 128_000, reasoning: true, toolCall: true }),
  kiroModel({ id: "gpt-5.6-terra", ctx: 272_000, out: 128_000, reasoning: true, toolCall: true }),
  kiroModel({ id: "gpt-5.6-luna", ctx: 272_000, out: 128_000, reasoning: true, toolCall: true }),
  // The non-Anthropic rows reject image and audio input upstream.
];

/**
 * The context window of a model id, as this catalog declares it.
 *
 * The upstream reports prompt size only as a *percentage* of the model's window
 * (`contextUsageEvent`), never as a token count, so recovering a token figure
 * needs the denominator. This is the only place Kiro states one.
 *
 * Matching is case-insensitive and falls back to 200k rather than returning
 * `undefined`: a token estimate derived from the wrong window is still far
 * closer than reporting nothing. A discovery-synced row this catalog does not
 * name takes that same default.
 */
export function kiroContextWindow(modelId: string): number {
  const normalized = modelId.trim().toLowerCase();
  for (const model of KIRO_MODELS) {
    if (model.modelId.toLowerCase() === normalized && model.contextLimit !== null) return model.contextLimit;
  }
  return KIRO_DEFAULT_CONTEXT_WINDOW;
}

/** Window used for a model this catalog does not name; the Anthropic rows' value. */
export const KIRO_DEFAULT_CONTEXT_WINDOW = 200_000;
