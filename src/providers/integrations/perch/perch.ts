// Perch adapter (pure HTTP).
//
// Auth: Supabase PKCE OAuth (see perch-oauth.ts). Inference: direct
// `POST /api/perch-terminal/model-call` with the CLI turn envelope — a fresh
// turn ticket minted with `{surface:"cli", profile:"standard"}`, the Roost
// tier (`roostModelChoice`), the account attribution, and the Saffron
// system-prompt prefix (the server fingerprints it and refuses anything else
// with `403 perch_surface_required`; verified live 2026-11-08).
//
// The stream is SSE (`answer_delta` / `done`); the adapter translates it into
// canonical events. No CLI process, no spawn, no external dependency.

import type {
  CanonicalEvent,
  CanonicalRequest,
  UsageRecord,
} from "../../../protocol/canonical-model";
import { canonicalTerminal } from "../../../protocol/codecs";
import { GatewayError } from "../../../protocol/gateway-error";
import {
  assertWireFamily,
  readCredentialSecret,
  type OutboundFetch,
  type ProviderAdapter,
  type ProviderDispatchContext,
  type ProviderDispatchTarget,
  type ProviderId,
} from "../../provider-contracts";
import { usageFromProvider } from "../../provider-usage";
import {
  PERCH_APP_URL,
  PERCH_CLI_USER_AGENT,
  PERCH_SAFFRON_SYSTEM_PROMPT,
  buildPerchModelCallBody,
  parsePerchSse,
  summarizePerchStream,
} from "./perch-protocol";
import {
  PERCH_MODEL_PINS,
  PERCH_MODEL_ROOST_TIERS,
} from "./perch-catalog";
import { PERCH_PROVIDER_ID } from "./perch-realm";

interface PerchAdapterOptions {
  readonly providerId?: string;
  /** Explicit transport override for tests; live dispatch uses `context.outbound_fetch`. */
  readonly fetch?: OutboundFetch;
}

interface PerchAccountSession {
  readonly userId: string | null;
  readonly workspaceId: string | null;
  readonly orgId: string | null;
  readonly planCode: string | null;
}

export class PerchAdapter implements ProviderAdapter {
  readonly provider_id: ProviderId;
  private readonly fetchOverride: OutboundFetch | undefined;

  constructor(options: PerchAdapterOptions = {}) {
    this.provider_id = (options.providerId ?? PERCH_PROVIDER_ID) as ProviderId;
    this.fetchOverride = options.fetch;
  }

  /** The Saffron system-prompt prefix the upstream fingerprints. */
  systemPrompt(): string | undefined {
    return PERCH_SAFFRON_SYSTEM_PROMPT;
  }

  /** Reads `userId`/`workspaceId` from the account endpoint for attribution. */
  async #accountSession(access: string, fetchFn: OutboundFetch): Promise<PerchAccountSession> {
    try {
      const res = await fetchFn(`${PERCH_APP_URL}/api/perchai/account`, {
        headers: { authorization: `Bearer ${access}`, accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return { userId: null, workspaceId: null, orgId: null, planCode: null };
      const body = (await res.json()) as { session?: Record<string, unknown> };
      const ctx = body.session ?? {};
      return {
        userId: typeof ctx["userId"] === "string" ? ctx["userId"] : null,
        workspaceId: typeof ctx["workspaceId"] === "string" ? ctx["workspaceId"] : null,
        orgId: typeof ctx["orgId"] === "string" ? ctx["orgId"] : null,
        planCode: typeof ctx["planCode"] === "string" ? ctx["planCode"] : null,
      };
    } catch {
      return { userId: null, workspaceId: null, orgId: null, planCode: null };
    }
  }

  /** Mints a CLI turn ticket (`{surface:"cli", profile:"standard"}`). */
  async #mintTicket(access: string, fetchFn: OutboundFetch): Promise<{ ticket: string; runId: string }> {
    const res = await fetchFn(`${PERCH_APP_URL}/api/perch-terminal/turn-ticket`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${access}`,
        "content-type": "application/json",
        "user-agent": PERCH_CLI_USER_AGENT,
        "x-perch-locale": "en",
      },
      body: JSON.stringify({ surface: "cli", profile: "standard" }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; ticket?: string; runId?: string; error?: string; errorCode?: string } | null;
    if (!res.ok || !body?.ok || !body.ticket || !body.runId) {
      const message = body?.error ?? `HTTP ${res.status}`;
      const providerCode = body?.errorCode;
      // Upstream verdict: 429/turn_rate_limited cools this account so routing
      // tries the next one instead of hammering the same key all day.
      if (res.status === 429 || providerCode === "turn_rate_limited") {
        throw upstreamPerchError("rate_limited", 429, `Perch turn ticket mint failed: ${message}`, providerCode);
      }
      throw upstreamPerchError("authentication_failed", 401, `Perch turn ticket mint failed: ${message}`, providerCode);
    }
    return { ticket: body.ticket, runId: body.runId };
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (candidate.wire_family !== "chat") {
      assertWireFamily(candidate, "chat", "perch");
    }
    const secret = readCredentialSecret(context.credential, "Perch credential is required");
    const modelId = candidate.model_id || request.model || "standard";
    const access = secret.startsWith("{") ? parseAccessToken(secret) : secret.trim();
    // Probes pass a validated outbound fetch (with capture wrapped around it);
    // live dispatch passes one too. `globalThis.fetch` here silently split the
    // probe from the route's egress policy and left Request Detail empty.
    const fetchFn = context.outbound_fetch ?? this.fetchOverride ?? globalThis.fetch;

    let seq = 0;
    yield {
      type: "message_start",
      sequence_number: ++seq,
      model: modelId,
      timestamp: Date.now(),
    };

    const ticket = await this.#mintTicket(access, fetchFn);
    const account = await this.#accountSession(access, fetchFn);

    const body = buildPerchModelCallBody(request, modelId, {
      userId: account.userId,
      workspaceId: account.workspaceId,
      orgId: account.orgId,
      planCode: account.planCode,
      runId: ticket.runId,
      pin: PERCH_MODEL_PINS[modelId],
      roostTier: PERCH_MODEL_ROOST_TIERS[modelId],
    });

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    context.abort_signal.addEventListener("abort", onAbort, { once: true });
    let streamText = "";
    try {
      const res = await fetchFn(`${PERCH_APP_URL}/api/perch-terminal/model-call`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${access}`,
          "content-type": "application/json",
          accept: "text/event-stream",
          "user-agent": PERCH_CLI_USER_AGENT,
          "x-perch-locale": "en",
          "x-perch-call-delta": "1",
          "x-perch-turn-ticket": ticket.ticket,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const raw = await res.text();
      if (!res.ok) {
        let message = `Perch model-call failed: HTTP ${res.status}`;
        let providerCode: string | undefined;
        try {
          const parsed = JSON.parse(raw) as { error?: string; errorCode?: string; limit?: Record<string, unknown> };
          if (parsed.error) message = parsed.error;
          providerCode = parsed.errorCode;
          if (parsed.errorCode === "starter_model_blocked" || parsed.errorCode === "plan_model_blocked") {
            throw upstreamPerchError("policy_rejected", 403, message, providerCode);
          }
          if (res.status === 429 || parsed.errorCode === "turn_rate_limited") {
            throw upstreamPerchError("rate_limited", 429, message, providerCode);
          }
        } catch (e) {
          if (e instanceof GatewayError) throw e;
        }
        throw upstreamPerchError("platform_unavailable", 502, message, providerCode);
      }

      const events = parsePerchSse(raw);
      const result = summarizePerchStream(events);
      streamText = result.text;

      if (!result.ok) {
        const message = result.error ?? "Perch returned no answer";
        const category = result.errorCode === "usage_limit_reached" ? "usage_limit" : "server_error";
        yield {
          type: "error",
          sequence_number: ++seq,
          category,
          message,
          retryable: false,
          timestamp: Date.now(),
        };
        yield canonicalTerminal({
          sequenceNumber: ++seq,
          state: "failed",
          stopReason: "error",
          providerStopReason: result.errorCode ?? "error",
        });
        return;
      }

      if (streamText.length > 0) {
        yield {
          type: "content_delta",
          sequence_number: ++seq,
          content: { kind: "text", text: streamText },
          timestamp: Date.now(),
        };
      }

      const usage = result.usage ? usageFromProvider(normalizePerchUsage(result.usage)) : undefined;
      const usageRecord: UsageRecord = usage ?? {
        input_tokens: 0,
        cached_input_tokens: "unavailable",
        cache_write_tokens: "unavailable",
        uncached_input_tokens: "unavailable",
        output_tokens: 0,
        reasoning_tokens: "unavailable",
        estimated_cost: null,
        total_tokens: 0,
      };
      yield {
        type: "usage",
        sequence_number: ++seq,
        usage: usageRecord,
        timestamp: Date.now(),
      };

      const terminalEvent = canonicalTerminal({
        sequenceNumber: ++seq,
        state: "complete",
        stopReason: "stop",
        providerStopReason: "stop",
        usage: usageRecord,
      });
      yield {
        ...terminalEvent,
        ...(result.model ? { provider_metadata: { model: result.model, provider: result.provider } } : {}),
      };
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      if (controller.signal.aborted) {
        throw new GatewayError("transport_closed", 499, "Perch request aborted");
      }
      throw new GatewayError("transport_unavailable", 502, `Perch request failed: ${(error as Error).message}`);
    } finally {
      context.abort_signal.removeEventListener("abort", onAbort);
    }
  }
}

/** Maps Perch's camelCase usage fields onto the canonical snake_case names. */
function normalizePerchUsage(usage: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...usage };
  if (out["input_tokens"] === undefined && typeof usage["inputTokens"] === "number") {
    out["input_tokens"] = usage["inputTokens"];
  }
  if (out["output_tokens"] === undefined && typeof usage["outputTokens"] === "number") {
    out["output_tokens"] = usage["outputTokens"];
  }
  if (out["total_tokens"] === undefined && typeof usage["totalTokens"] === "number") {
    out["total_tokens"] = usage["totalTokens"];
  }
  return out;
}

function parseAccessToken(secret: string): string {
  try {
    const parsed = JSON.parse(secret) as Record<string, unknown>;
    const found = parsed["accessToken"] ?? parsed["access_token"];
    return typeof found === "string" ? found : secret.trim();
  } catch {
    return secret.trim();
  }
}

/**
 * Builds an upstream verdict for the Perch surface. `origin: "upstream"` is
 * what lets the account health machine see the failure: `attempt-finalize`
 * only records health for `GatewayError`s whose origin is upstream, so a
 * `turn_rate_limited` minted as a local error never cooled the account and
 * routing kept dialing the same key.
 */
function upstreamPerchError(
  code: GatewayError["code"],
  status: number,
  message: string,
  providerCode: string | undefined,
): GatewayError {
  return new GatewayError(code, status, message, {
    providerId: PERCH_PROVIDER_ID,
    ...(providerCode ? { providerCode } : {}),
  }, "upstream");
}

export function createPerchAdapter(options: PerchAdapterOptions = {}): PerchAdapter {
  return new PerchAdapter(options);
}
