// Free-pi adapter.
//
// OpenAI-completions wire with a JWT bearer. The model catalog is
// server-driven (`GET /client-version`); dispatch posts to
// `/v1/chat/completions` and translates the OpenAI-style SSE stream into
// canonical events.

import { randomUUID } from "node:crypto";
import type {
  CanonicalEvent,
  CanonicalRequest,
  CanonicalMessage,
  CanonicalStopReason,
} from "../../../protocol/canonical-model";
import { GatewayError } from "../../../protocol/gateway-error";
import {
  assertWireFamily,
  readCredentialSecret,
  type ProviderAdapter,
  type ProviderDispatchContext,
  type ProviderDispatchTarget,
  type ProviderId,
} from "../../provider-contracts";
import { mapUpstreamHttpError } from "../../../transport/failure-policy";
import { abortGatewayError, createUpstreamDeadlineLifecycle } from "../../operations/upstream-deadline";
import { resolvePromptCacheKey } from "../../operations/session-resolution";
import { usageFromProvider } from "../../provider-usage";
import { buildFreepiChatBody, parseFreepiSse, throwFreepiUpstreamError } from "./freepi-protocol";
import { buildFreepiHeaders } from "./freepi-headers";
import {
  FREEPI_AD_IMPRESSION_PATH,
  FREEPI_AD_NEXT_PATH,
  FREEPI_BASE_URL,
  FREEPI_CHAT_PATH,
  FREEPI_PROVIDER_ID,
} from "./freepi-realm";

const STOP_REASONS: Readonly<Record<string, CanonicalStopReason>> = {
  stop: "stop",
  length: "length",
  tool_calls: "tool_use",
  function_call: "tool_use",
};

interface FreepiAdapterOptions {
  readonly providerId?: string;
  readonly fetch?: typeof fetch;
}

export class FreepiAdapter implements ProviderAdapter {
  readonly provider_id: ProviderId;
  private readonly fetchFn: typeof fetch;
  /**
   * One stable ad-registered session id per account credential, so repeated
   * chats reuse a session the upstream knows has shown ads. The session must
   * exist for the chat wire: without it the server answers `ads_required`
   * ("Ads aren't showing for this account, so free completions are paused").
   */
  #sessionByCredential = new Map<string, string>();

  constructor(options: FreepiAdapterOptions = {}) {
    this.provider_id = (options.providerId ?? FREEPI_PROVIDER_ID) as ProviderId;
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  /**
   * Ensures a session id exists for this credential and that the session has
   * registered at least one ad impression (banner + inline). The upstream
   * refuses the chat wire with `ads_required` until a session has shown ads,
   * so the first call per credential pays the two ad-registration requests.
   *
   * Returns the session id to send as `x-session-id`. Falls back to a fresh
   * random id when registration fails — a broken ad surface must not block
   * chat entirely, and the error is caught upstream anyway.
   */
  async #ensureSession(secret: string, outboundFetch: typeof fetch): Promise<string> {
    const existing = this.#sessionByCredential.get(secret);
    if (existing !== undefined) return existing;
    const sessionId = randomUUID();
    try {
      for (const slot of ["banner", "inline"] as const) {
        const next = await outboundFetch(new URL(`${FREEPI_AD_NEXT_PATH}?slot=${slot}`, FREEPI_BASE_URL), {
          method: "GET",
          headers: buildFreepiHeaders(secret, false, sessionId),
          signal: AbortSignal.timeout(15_000),
        });
        if (!next.ok || next.status === 204) continue;
        const ad = (await next.json()) as Record<string, unknown>;
        const adId = ad["ad_id"];
        const clickToken = ad["click_token"];
        if (typeof adId !== "string" || typeof clickToken !== "string") continue;
        await outboundFetch(new URL(FREEPI_AD_IMPRESSION_PATH, FREEPI_BASE_URL), {
          method: "POST",
          headers: buildFreepiHeaders(secret, false, sessionId),
          body: JSON.stringify({ ad_id: adId, click_token: clickToken, imp_fired: true }),
          signal: AbortSignal.timeout(15_000),
        });
      }
    } catch {
      // The ad surface is best-effort; chat may still work or fail upstream.
    }
    this.#sessionByCredential.set(secret, sessionId);
    return sessionId;
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (candidate.wire_family !== "chat") {
      assertWireFamily(candidate, "chat", "freepi");
    }
    const secret = readCredentialSecret(context.credential, "Free-pi credential is required");
    const modelId = candidate.model_id || request.model;
    const lifecycle = createUpstreamDeadlineLifecycle(context);
    const outboundFetch =
      (context.outbound_fetch as unknown as typeof fetch | undefined) ?? this.fetchFn;

    const body = buildFreepiChatBody(modelId, request, candidate.output_limit ?? undefined);

    const sessionKey = resolvePromptCacheKey(request, context);
    const cacheSessionKey = sessionKey === undefined ? undefined : `${modelId}:${sessionKey}`;

    const sessionId = await this.#ensureSession(secret, outboundFetch);
    const headers = buildFreepiHeaders(secret, true, sessionId);
    const url = `${FREEPI_BASE_URL}${FREEPI_CHAT_PATH}`;

    try {
      const response = await outboundFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: lifecycle.signal,
      });
      if (!response.ok) throw await mapUpstreamHttpError(response, this.provider_id);
      if (!response.body) {
        throw new GatewayError("platform_unavailable", 502, "Free-pi returned empty body (request {requestId}). The upstream came back empty-handed — retry 🌙", {}, "upstream");
      }
      lifecycle.release();
      yield* this.#events(
        response.body as ReadableStream<Uint8Array>,
        lifecycle.signal,
        request.model,
        cacheSessionKey,
        request.messages,
      );
    } catch (err: unknown) {
      const abortError = abortGatewayError(lifecycle, err, context.abort_signal);
      if (abortError) throw abortError;
      throw err;
    } finally {
      lifecycle.release();
    }
  }

  async *#events(
    body: ReadableStream<Uint8Array>,
    _signal: AbortSignal,
    requestModel: string,
    sessionId?: string,
    _messages?: readonly CanonicalMessage[],
  ): AsyncIterable<CanonicalEvent> {
    let seq = 1;
    yield { type: "response_start", sequence_number: seq++, model: requestModel } as CanonicalEvent;
    let stopReason: CanonicalStopReason = "stop";
    let usage: Record<string, unknown> | undefined;
    const toolCallIds = new Map<string, string>();
    const announced = new Set<string>();

    for await (const frame of parseFreepiSse(body)) {
      if (frame.event === "done") {
        const data = frame.data as { finish_reason?: unknown };
        if (typeof data.finish_reason === "string") {
          stopReason = STOP_REASONS[data.finish_reason] ?? "stop";
        }
        continue;
      }
      if (typeof frame.data !== "object" || frame.data === null) continue;
      const record = frame.data as Record<string, unknown>;

      // Upstream error payloads can be HTTP 200 `{"error":{...}}`.
      if (record["error"] !== undefined && typeof record["error"] === "object") {
        const nested = record["error"] as Record<string, unknown>;
        throwFreepiUpstreamError(nested["code"], nested["message"]);
      }
      if (record["code"] !== undefined) {
        throwFreepiUpstreamError(record["code"], record["message"]);
      }

      const choices = Array.isArray(record["choices"]) ? (record["choices"] as Record<string, unknown>[]) : [];
      const choice = choices[0];
      if (!choice) continue;
      const delta = choice["delta"] as Record<string, unknown> | undefined;
      if (!delta) continue;

      const text = delta["content"];
      if (typeof text === "string" && text.length > 0) {
        yield {
          type: "content_delta",
          sequence_number: seq++,
          content: { kind: "text", text },
        } as CanonicalEvent;
      }
      const reasoning = delta["reasoning_content"];
      if (typeof reasoning === "string" && reasoning.length > 0) {
        yield {
          type: "content_delta",
          sequence_number: seq++,
          content: { kind: "reasoning", payload: null, summary: reasoning },
        } as CanonicalEvent;
      }
      yield* this.#toolCallDeltas(delta["tool_calls"], announced, toolCallIds, () => seq++);
      if (typeof choice["finish_reason"] === "string" && choice["finish_reason"] !== null) {
        stopReason = STOP_REASONS[String(choice["finish_reason"])] ?? "stop";
      }
      const u = record["usage"];
      if (typeof u === "object" && u !== null) usage = u as Record<string, unknown>;
    }

    const assessed = usage === undefined ? undefined : usageFromProvider(usage);
    if (assessed !== undefined) {
      yield { type: "usage", sequence_number: seq++, usage: assessed } as unknown as CanonicalEvent;
    }
    yield {
      type: "terminal",
      sequence_number: seq,
      state: "complete",
      stop_reason: stopReason,
      ...(assessed === undefined ? {} : { usage: assessed }),
      ...(sessionId !== undefined ? { prompt_cache_key: sessionId } : {}),
    } as unknown as CanonicalEvent;
  }

  /**
   * Emits canonical tool-call deltas from one OpenAI `tool_calls` array.
   *
   * The upstream spreads one call over many frames: the first carries id and
   * name, the middle ones carry `arguments` as successive JSON fragments with
   * an empty id, and the last repeats the id with no arguments. Grouping by
   * `index` ties them together — the id is absent exactly when the arguments
   * are present, so keying on id would drop every fragment.
   */
  async *#toolCallDeltas(
    raw: unknown,
    announced: Set<string>,
    toolCallIds: Map<string, string>,
    nextSeq: () => number,
  ): AsyncIterable<CanonicalEvent> {
    if (!Array.isArray(raw)) return;
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) continue;
      const call = entry as Record<string, unknown>;
      const fn = call["function"];
      const fnRecord = typeof fn === "object" && fn !== null ? (fn as Record<string, unknown>) : undefined;
      const name = typeof fnRecord?.["name"] === "string" ? (fnRecord["name"] as string) : undefined;
      const args = typeof fnRecord?.["arguments"] === "string" ? (fnRecord["arguments"] as string) : "";
      const declaredId = typeof call["id"] === "string" ? call["id"] : "";
      const index = typeof call["index"] === "number" ? call["index"] : 0;
      const slot = `idx:${index}`;

      if (declaredId.length > 0) {
        toolCallIds.set(slot, declaredId);
        if (announced.has(declaredId)) continue;
        announced.add(declaredId);
        yield {
          type: "tool_call_delta",
          sequence_number: nextSeq(),
          call_id: declaredId,
          name: name ?? "",
          arguments_delta: "",
        } as CanonicalEvent;
        if (args.length === 0) continue;
      }

      if (args.length === 0) continue;
      const id = toolCallIds.get(slot);
      if (id === undefined) continue;
      yield {
        type: "tool_call_delta",
        sequence_number: nextSeq(),
        call_id: id,
        arguments_delta: args,
      } as CanonicalEvent;
    }
  }
}

/** Adapter for the international free-pi deployment. */
export function createFreepiAdapter(options: FreepiAdapterOptions = {}): ProviderAdapter {
  return new FreepiAdapter({ ...options, providerId: FREEPI_PROVIDER_ID });
}
