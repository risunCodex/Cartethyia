/**
 * Fallback-credit token cache for Claude refusal redemption.
 *
 * When Claude returns a refusal carrying `stop_details.fallback_credit_token`,
 * that token buys one free replay of the *refused* body within its redemption
 * window. The wire shape is taken verbatim from the reference client source
 * (`packages/ai/src/providers/anthropic.ts`):
 *
 * - `:243-248` — `FALLBACK_CREDIT_TTL_MS = 5 * 60 * 1000`. `stop_details`
 *   reports no expiry; five minutes from the refusal is the documented window
 *   (https://platform.claude.com/docs/en/build-with-claude/fallback-credit).
 * - `:3295-3309` — the token is captured from a refusal's `stop_details` when
 *   `stop_details.type === "refusal"` and `fallback_credit_token` is present.
 * - `:1633-1646` (`fallbackCreditRequestBody`) — the redemption body is a
 *   `structuredClone` of the refused request's params with
 *   `body.fallback_credit_token = redemption.token` set **top-level on the
 *   body**, NOT nested inside `stop_details`; `body.fallbacks` deleted; and
 *   `body.model` retargeted at the fallback model.
 * - `:3469-3481` — a 400 whose message includes `fallback_credit_token`
 *   forfeits the token and retries the standard request once without it
 *   (`dropAllThinking = true; params = await prepareParams()`). Pinned by
 *   `packages/ai/test/anthropic-stream-envelope.test.ts:2145-2211`.
 * - `:242-243` — the `fallback-credit-2026-06-01` beta is associated with it.
 *
 * The token is bound to the body that was refused, so entries are keyed by a
 * hash of that body: only an identical replay may spend it.
 */

import { GatewayError } from "../../../protocol/gateway-error";
import { fnv1a32 } from "../shared/hash";

const CREDIT_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 64;

/** Redemption window of a refusal's credit token (donor `anthropic.ts:248`). */
export const FALLBACK_CREDIT_TTL_MS = CREDIT_TTL_MS;

/** Beta the credit rides with (donor `anthropic.ts:242`). */
export const FALLBACK_CREDIT_BETA = "fallback-credit-2026-06-01";

/**
 * `provider_options` key naming the model a redemption is retargeted at.
 *
 * The donor always retargets (`body.model = targetModelId`,
 * `anthropic.ts:1639`) at a model its catalog declares a permitted credit
 * target for the refused model (`turn-recovery.ts:2229-2236`,
 * `fallbackCreditTargets(failedModel)`). This repo has no credit-target
 * catalog, so the target is never guessed: without this key the redemption
 * replays on the model that was refused, which is still a valid spend of the
 * token, just not a model switch.
 */
export const CLAUDE_FALLBACK_CREDIT_MODEL_OPTION = "claude_fallback_credit_model";

export interface FallbackCreditEntry {
  readonly token: string;
  readonly expiresAt: number;
}

/**
 * LRU cache for fallback-credit tokens. Keyed by a hash of the request body.
 * Evicts oldest entries when the cache exceeds `maxSize`.
 */
export class FallbackCreditCache {
  private readonly cache = new Map<string, FallbackCreditEntry>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(options: { maxSize?: number; ttlMs?: number } = {}) {
    this.maxSize = options.maxSize ?? MAX_CACHE_SIZE;
    this.ttlMs = options.ttlMs ?? CREDIT_TTL_MS;
  }

  /** Get a cached token for the given body hash, or undefined if expired/missing. */
  get(key: string): string | undefined {
    const entry = this.cache.get(key);
    if (entry === undefined) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    // LRU: refresh position by re-inserting
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.token;
  }

  /** Store a token for the given body hash. */
  set(key: string, token: string): void {
    // Evict oldest if at capacity (Map preserves insertion order)
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) {
        this.cache.delete(oldest.value);
      }
    }
    // Refresh position if already present
    this.cache.delete(key);
    this.cache.set(key, {
      token,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /**
   * Remove one entry: a token is forfeited when the server rejects it and
   * spent once a replay carries it (the donor's redemption handle is one-shot
   * — `consumeActiveFallbackCreditRedemption`, `turn-recovery.ts:510-519`).
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /** Clear all entries. */
  clear(): void {
    this.cache.clear();
  }

  /** Current size (for tests). */
  get size(): number {
    return this.cache.size;
  }
}

/**
 * Compute a simple hash of the request body for cache keying.
 * FNV-1a — fast, deterministic, sufficient for cache identity.
 */
export function hashBody(body: string): string {
  return fnv1a32(body).toString(36);
}

// Shared process-wide cache instance
export const sharedFallbackCreditCache = new FallbackCreditCache();

/**
 * Reads a credit token out of a refusal's provider-native `stop_details`.
 *
 * Donor rule (`anthropic.ts:3295`): only a refusal carries a credit token —
 * `stopDetails?.type === "refusal" && stopDetails.fallback_credit_token`.
 * `stop_details` is provider JSON, so a malformed or non-string token is no
 * token at all rather than an error; a token is never fabricated.
 */
export function refusalCreditToken(
  stopDetails: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (stopDetails === undefined) return undefined;
  if (stopDetails["type"] !== "refusal") return undefined;
  const token = stopDetails["fallback_credit_token"];
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

/**
 * The refused request's frozen body replayed with the credit token.
 *
 * Donor shape (`anthropic.ts:1633-1646`), minus what this side cannot name:
 *
 * - `fallback_credit_token` is set **top-level on the body**. The donor writes
 *   `body.fallback_credit_token = redemption.token`; it is never nested inside
 *   `stop_details`, and an earlier draft of this module placed it there.
 * - `fallbacks` is deleted. The donor drops it because the redemption already
 *   names its target model; leaving a chain on the wire would let the server
 *   spend the credit on a hop the token was not minted for.
 * - OMITTED: `body.model = targetModelId` retargeting. The donor picks that id
 *   from catalog metadata this repo does not have; see
 *   {@link CLAUDE_FALLBACK_CREDIT_MODEL_OPTION}. Retargeting is therefore
 *   opt-in through that key and otherwise the body keeps its own `model`.
 * - OMITTED: the donor's echoed refusal continuation message
 *   (`anthropic.ts:1642-1644`). It replays the refused turn's thinking and
 *   server-tool blocks so a prefill claim can resume; doing so here would
 *   require echoing provider content this repo does not retain on the canonical
 *   stream, and a wrong continuation is a 400 the donor itself retries away
 *   (`:3452-3467`). The token alone is the win.
 *
 * Returns `undefined` when the body is not a JSON object, so a caller can never
 * inject a token into a payload it could not read.
 */
export function fallbackCreditRequestBody(
  refusedBody: string,
  token: string,
  targetModelId?: string | undefined,
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(refusedBody) as unknown;
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const body = parsed as Record<string, unknown>;
  body["fallback_credit_token"] = token;
  delete body["fallbacks"];
  if (targetModelId !== undefined && targetModelId.length > 0) {
    body["model"] = targetModelId;
  }
  return JSON.stringify(body);
}

/**
 * Marks a 400 as one that rejects the credit token itself.
 *
 * Donor rule (`anthropic.ts:3469`): `errMessage.includes("fallback_credit_token")`
 * on a 400 — the token is forfeited and the standard request is retried once
 * without it. A 400 alone is not enough: plenty of unrelated 400s (a bad
 * `max_tokens`, a malformed tool schema) would otherwise be retried once and
 * billed twice. Donor-pinned by
 * `packages/ai/test/anthropic-stream-envelope.test.ts:2145-2211`.
 */
export function isFallbackCreditTokenRejection(error: unknown): boolean {
  if (error instanceof GatewayError) {
    if (error.status !== 400) return false;
  } else {
    return false;
  }
  return error.message.includes("fallback_credit_token");
}

/**
 * Reads the declared redemption target model out of `provider_options`.
 *
 * Only a non-empty string is honored: a target that names nothing would put
 * `model: undefined` on the wire, and inventing a fallback model is exactly
 * what this module refuses to do.
 */
export function fallbackCreditTargetModel(
  providerOptions: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const declared = providerOptions?.[CLAUDE_FALLBACK_CREDIT_MODEL_OPTION];
  if (typeof declared !== "string") return undefined;
  const trimmed = declared.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
