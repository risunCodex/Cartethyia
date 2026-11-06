// Trae adapter.
//
// Realm-aware: `trae` (intl) and `traecn` (CN) share this code but nothing of
// the address or the roster. Both realms authenticate with
// `Authorization: Cloud-IDE-JWT <token>` per the Trae 1.107.1 bundle.

import { GatewayError } from "../../../protocol/gateway-error";
import type { CanonicalEvent, CanonicalMessage, CanonicalRequest, CanonicalStopReason } from "../../../protocol/canonical-model";
import type { UsageRecord } from "../../../protocol/canonical-model";
import { usageFromProvider } from "../../provider-usage";
import {
  readCredentialSecret,
  assertWireFamily,
  type ProviderAdapter,
  type ProviderDispatchContext,
  type ProviderDispatchTarget,
  type ProviderId,
} from "../../provider-contracts";
import { mapUpstreamHttpError } from "../../../transport/failure-policy";
import { abortGatewayError, createUpstreamDeadlineLifecycle } from "../../operations/upstream-deadline";
import { resolvePromptCacheKey } from "../../operations/session-resolution";
import { estimateTraeSessionCache } from "./trae-cache";
import { TRAE_CN_MODELS, TRAE_INTL_MODELS, traeMaxContextWindow } from "./trae-catalog";
import { buildTraeHeaders } from "./trae-headers";
import { getTraeVersion } from "../../operations/client-versions";
import {
  buildTraeChatBody,
  isTraeAgentEndpoint,
  parseTraeSse,
  toTraeAgentBody,
  TRAE_AGENT_ENDPOINT,
  TRAE_CHAT_ENDPOINT,
} from "./trae-protocol";
import { TRAE_REGION_CORE_HOSTS, traeCoreCandidates, TRAE_MODEL_LIST_PATH, TRAE_AGENT_FUNCTION, type TraeRealm } from "./trae-realm";

export interface TraeAdapterOptions {
  readonly providerId?: string;
  readonly realm?: TraeRealm;
  readonly fetch?: typeof fetch;
}

/** Identity resolved from a persisted credential. */
interface TraeAuth {
  readonly token: string;
  readonly uid: string;
}

const TRAE_PROVIDER_ID = "trae";
const TRAE_CN_PROVIDER_ID = "traecn";

/** Upstream finish reason → canonical stop reason. */
const STOP_REASONS: Readonly<Record<string, CanonicalStopReason>> = {
  stop: "stop",
  length: "length",
  tool_calls: "tool_use",
  function_call: "tool_use",
  content_filter: "content_filter",
};

/**
 * Reads the credential.
 *
 * Trae credentials are OAuth token pairs, so the whole JSON export is the
 * secret: extracting only the access token would drop the refresh token and
 * leave the account permanently unrefreshable. The refresh itself runs through
 * the registered OAuth refresher (`trae-oauth.ts`), not here — this only needs
 * the access token to authorize a request.
 */
function traeAuth(secret: string, accountId: string | undefined): TraeAuth {
  const token = extractToken(secret);
  if (token === undefined) {
    throw new GatewayError("authentication_failed", 401, "Trae credential has no access token (request {requestId}). Wrong key, right door — check the credential 🔑", {}, "upstream");
  }
  return { token, uid: accountId ?? "" };
}

function extractToken(secret: string): string | undefined {
  const trimmed = secret.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const candidates = ["accessToken", "access_token", "token", "x-ide-token"];
      for (const key of candidates) {
        const value = parsed[key];
        if (typeof value === "string" && value.length > 0) return value;
      }
    } catch {
      // Fall through to the bare-token reading below.
    }
  }
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Maps a Trae upstream error (a named `error` SSE event, or an error object
 * in a frame body) to the canonical GatewayError.
 *
 * Codes resolved from live probing (2026-11-06), not guessed:
 * - `1001` — "we are not able to authenticate you" — is a credential verdict.
 *   It must surface as account-scoped `authentication_failed` so the account
 *   is parked for re-login and failover tries a sibling — never the proxy
 *   pool. Note: the pay host answers it on *region mismatch* too (an sg
 *   account sent to the us pay host), which is not the same as an expired
 *   token — a token that answers `GetUserInfo` 200 is alive.
 * - `4008` / "exceeded the quota" — free-tier quota exhausted. That is a
 *   `quota_exceeded` 429, not a platform fault.
 * - `1005` (extra `{"plan":N}`) and `4015` — entitlement verdicts. Verified
 *   live: identical wire, a paid-capable account streams the same model fine
 *   while a Free account is refused with these codes, and the refused
 *   account's token still answers `GetUserInfo` 200. Neither auth nor
 *   platform fault: `quota_exceeded`.
 * - `4013` / region message — durable regional unavailability, scoped by the
 *   classifier to the account (`trae-region-unavailable`).
 * - Everything else is a platform fault (`platform_unavailable`).
 */
function throwTraeUpstreamError(
  codeRaw: unknown,
  messageRaw: unknown,
  providerId?: string,
): never {
  const code =
    typeof codeRaw === "number" || typeof codeRaw === "string" ? String(codeRaw) : undefined;
  const message =
    typeof messageRaw === "string" && messageRaw.trim().length > 0
      ? messageRaw.trim()
      : code !== undefined
        ? `Trae stream error (upstream code ${code})`
        : "Trae stream error";

  if (code === "1001") {
    throw new GatewayError(
      "authentication_failed",
      401,
      `Trae could not authenticate the account (upstream code 1001): ${message} (request {requestId}). Wrong key, right door — check the credential 🔑`,
      {
        providerCode: "1001",
        providerStatus: 1001,
        credentialEvidence: true,
        ...(providerId ? { providerId } : {}),
      },
      "upstream",
    );
  }

  const lower = message.toLowerCase();
  if (code === "4008" || lower.includes("exceeded the quota") || lower.includes("quota")) {
    throw new GatewayError(
      "quota_exceeded",
      429,
      `Trae quota exceeded (upstream code ${code ?? "unknown"}): ${message} (request {requestId}). You've maxed this window — pace yourself ⏳`,
      {
        providerCode: code ?? "4008",
        providerStatus: code === "4008" ? 4008 : 429,
        ...(providerId ? { providerId } : {}),
      },
      "upstream",
    );
  }

  // Trae answers `4013 "AI service is not available in the current region now."`
  // when the upstream does not serve the account's region. That is a durable
  // verdict, not a transient transport fault: the account reproduces it on
  // every request until the region opens, so it must cool hard rather than be
  // re-dialled every thirty seconds. The classifier scopes this to the account
  // (`trae-region-unavailable`) — never the proxy pool.
  if (code === "4013" || lower.includes("not available in the current region")) {
    throw new GatewayError(
      "platform_unavailable",
      502,
      message,
      { providerCode: "4013", ...(providerId ? { providerId } : {}) },
      "upstream",
    );
  }

  // `1005` and `4015` are entitlement verdicts, not auth failures and not
  // platform faults. Verified live: the same wire streams fine on a
  // paid-capable account while a Free account is refused with these codes,
  // and the refused account's token still answers `GetUserInfo` 200. Treating
  // them as auth would park the account for re-login pointlessly; treating
  // them as platform faults would failover to another account that hits the
  // same wall. They are `quota_exceeded` — the model/account cannot serve.
  if (code === "1005" || code === "4015") {
    throw new GatewayError(
      "quota_exceeded",
      429,
      `Trae model not available on this account (upstream code ${code}): ${message} (request {requestId}). The model needs a plan or permission this account does not hold — pick another model or account ⏳`,
      {
        providerCode: code,
        providerStatus: code === "1005" ? 1005 : 4015,
        ...(providerId ? { providerId } : {}),
      },
      "upstream",
    );
  }

  throw new GatewayError(
    "platform_unavailable",
    502,
    message,
    { ...(providerId ? { providerId } : {}) },
    "upstream",
  );
}

class TraeAdapter implements ProviderAdapter {
  readonly provider_id: ProviderId;
  private readonly realm: TraeRealm;
  private readonly fetchFn: typeof fetch;
  constructor(options: TraeAdapterOptions = {}) {
    this.provider_id = (options.providerId ?? TRAE_PROVIDER_ID) as ProviderId;
    this.realm = options.realm ?? "intl";
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    if (candidate.wire_family !== "chat") {
      assertWireFamily(candidate, "chat", "trae");
    }
    const secret = readCredentialSecret(context.credential, "Trae credential is required");
    const modelId = candidate.model_id || request.model;
    const lifecycle = createUpstreamDeadlineLifecycle(context);
    const outboundFetch =
      (context.outbound_fetch as unknown as typeof fetch | undefined) ?? this.fetchFn;

    const auth = traeAuth(secret, context.credential.account_id);
    /**
     * Trae keeps upstream prompt-cache state keyed by the request's
     * `session_id`. The canonical request rarely carries one (surfaces do not
     * populate it), so without this the body always omitted `session_id` and
     * upstream treated every turn as a fresh context — `cached_tokens: 0`
     * even for byte-identical prefixes. Resolve the same session/cache key the
     * other adapters use (caller key → inbound session headers → opening-turn
     * hash) and thread it through.
     */
    const sessionId = request.session_id ?? resolvePromptCacheKey(request, context);
    const body = buildTraeChatBody(
      modelId,
      request,
      this.realm,
      sessionId,
      candidate.output_limit ?? undefined,
    );
    // The cache estimator is scoped per (session, model): upstream cache keys
    // are model-specific, so two models sharing a conversation id must not
    // treat each other's identical prefixes as hits.
    const cacheSessionKey = sessionId === undefined ? undefined : `${modelId}:${sessionId}`;
    /**
     * The endpoint follows the model, not the provider.
     *
     * Trae's two surfaces are disjoint and neither serves the other's ids, so
     * the roster's own `endpoint_path` decides. Falling back to the agent path
     * rather than the chat one matters: the intl catalog is agent-only, and a
     * caller whose target carries no route would otherwise land on a surface
     * that rejects every model in it.
     */
    const agentSurface = isTraeAgentEndpoint(candidate.endpoint_path);
    const payload = agentSurface ? toTraeAgentBody(body) : body;
    const headers = buildTraeHeaders({
      realm: this.realm,
      token: auth.token,
      uid: auth.uid,
      stream: true,
      appVersion: getTraeVersion(),
      trafficType: agentSurface ? "agent" : "chat",
    });

    const primary = traeCoreForAccount(this.realm, context.credential.auth_state);
    const path = agentSurface ? TRAE_AGENT_ENDPOINT : TRAE_CHAT_ENDPOINT;
    const url =
      candidate.endpoint_path && candidate.endpoint_path.startsWith("http")
        ? candidate.endpoint_path
        : `${primary}${path}`;

    try {
      const response = await outboundFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: lifecycle.signal,
      });
      if (!response.ok) throw await mapUpstreamHttpError(response, this.provider_id);
      if (!response.body) {
        throw new GatewayError("platform_unavailable", 502, "Trae returned empty body (request {requestId}). The upstream came back empty-handed — retry 🌙", {}, "upstream");
      }
      // Headers arrived, so the pre-stream deadline has served its purpose;
      // from here the gateway's own stall watchdog governs the body.
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
    messages?: readonly CanonicalMessage[],
  ): AsyncIterable<CanonicalEvent> {
    let seq = 1;
    yield { type: "response_start", sequence_number: seq++, model: requestModel } as CanonicalEvent;
    let stopReason: CanonicalStopReason = "stop";
    let usage: Record<string, unknown> | undefined;
    // Tool ids are scoped to one stream. Argument-only frames from a later
    // request must never inherit an earlier request's id at the same index.
    const toolCallIds = new Map<string, string>();
    /**
     * Tool calls arrive fragmented across frames and the id is not repeated.
     *
     * Upstream streams one `tool_calls` array per frame where only the first
     * carries `id`, only early frames carry `name`, and `arguments` arrives as
     * successive JSON fragments. So name is announced once on first sight of
     * the id and arguments are accumulated; emitting each frame verbatim would
     * produce several calls with empty ids.
     */
    const announced = new Set<string>();

    for await (const frame of parseTraeSse(body)) {
      if (frame.event === "done") {
        const data = frame.data as { finish_reason?: unknown };
        if (typeof data.finish_reason === "string") {
          stopReason = STOP_REASONS[data.finish_reason] ?? "stop";
        }
        continue;
      }
      if (frame.event === "error") {
        const data = frame.data as { message?: unknown; code?: unknown };
        throwTraeUpstreamError(data.code, data.message, this.provider_id);
      }
      if (typeof frame.data !== "object" || frame.data === null) continue;
      const record = frame.data as Record<string, unknown>;
      // The upstream can answer with an error object in the frame body rather
      // than a named `error` event — e.g. HTTP 200 carrying `{"code":1001,
      // "message":"…"}` (sometimes nested under an `error` key). Detect both
      // spellings so a rejected turn surfaces as the real error instead of an
      // empty stream that ends with a normal `stop`.
      if (record["code"] !== undefined || (typeof record["error"] === "object" && record["error"] !== null)) {
        const nested = record["error"] as Record<string, unknown> | undefined;
        const code = record["code"] ?? nested?.["code"];
        const message = record["message"] ?? nested?.["message"];
        throwTraeUpstreamError(code, message, this.provider_id);
      }
      /**
       * Two frame layouts reach here and both are live.
       *
       * Upstream's client nests the answer under `chunk`; the region host this
       * gateway talks to sends it flat — `event: output` with
       * `{"response":"…"}` — and reports usage as a separate `token_usage`
       * frame with the OpenAI spelling at the top level. Reading only `chunk`
       * made a working upstream look like an empty stream.
       */
      const chunk = record["chunk"];
      if (typeof chunk !== "object" || chunk === null) {
        const flat = record["response"];
        if (typeof flat === "string" && flat.length > 0) {
          yield {
            type: "content_delta",
            sequence_number: seq++,
            content: { kind: "text", text: flat },
          } as CanonicalEvent;
        }
        const flatReasoning = record["reasoning_content"];
        if (typeof flatReasoning === "string" && flatReasoning.length > 0) {
          yield {
            type: "content_delta",
            sequence_number: seq++,
            content: { kind: "reasoning", payload: null, summary: flatReasoning },
          } as CanonicalEvent;
        }
        yield* this.#toolCallDeltas(record["tool_calls"], announced, toolCallIds, () => seq++);
        if (typeof record["finish_reason"] === "string") {
          stopReason = STOP_REASONS[record["finish_reason"] as string] ?? "stop";
        }
        // `token_usage` frames carry the counters themselves, not under `usage`.
        const counters =
          record["usage"] !== undefined && typeof record["usage"] === "object"
            ? (record["usage"] as Record<string, unknown>)
            : frame.event === "token_usage" || record["prompt_tokens"] !== undefined
              ? record
              : undefined;
        if (counters !== undefined) usage = counters;
        continue;
      }
      const payload = chunk as Record<string, unknown>;
      const text = payload["content"];
      if (typeof text === "string" && text.length > 0) {
        yield {
          type: "content_delta",
          sequence_number: seq++,
          content: { kind: "text", text },
        } as CanonicalEvent;
      }
      const reasoning = payload["reasoning_content"];
      if (typeof reasoning === "string" && reasoning.length > 0) {
        yield {
          type: "content_delta",
          sequence_number: seq++,
          content: { kind: "reasoning", payload: null, summary: reasoning },
        } as CanonicalEvent;
      }
      if (typeof payload["finish_reason"] === "string") {
        stopReason = STOP_REASONS[payload["finish_reason"] as string] ?? "stop";
      }
      yield* this.#toolCallDeltas(payload["tool_calls"], announced, toolCallIds, () => seq++);
      if (typeof payload["usage"] === "object" && payload["usage"] !== null) {
        usage = payload["usage"] as Record<string, unknown>;
      }
    }

    // Assess the raw usage exactly once per request, then reuse the result for
    // both the `usage` event and the terminal. Assessing twice would let the
    // terminal see the `usage` event's own history entry and misreport a cache
    // hit on the very first request.
    const assessed = usage === undefined ? undefined : this.#assessUsage(usage, sessionId, messages);
    if (assessed !== undefined) {
      yield { type: "usage", sequence_number: seq++, usage: assessed } as unknown as CanonicalEvent;
    }
    // The canonical terminal is `terminal`; a stream that ends without one is
    // read as "the upstream never reported a result". The assessed usage is
    // carried on the terminal itself (matching the other adapters) so the
    // non-streaming path records the real token counts instead of falling back
    // to the request estimate.
    yield {
      type: "terminal",
      sequence_number: seq,
      state: "complete",
      stop_reason: stopReason,
      ...(assessed === undefined ? {} : { usage: assessed }),
    } as unknown as CanonicalEvent;
  }

  /**
   * Emits canonical tool-call deltas from one `tool_calls` array.
   *
   * Upstream nests the payload under `function_call`, not OpenAI's `function`,
   * and spreads one call over many frames with three different shapes: the
   * first carries id and name, the middle ones carry `arguments` as successive
   * JSON fragments with an **empty** id, and the last repeats the id with no
   * arguments. Grouping by `index` is what ties them together — the id is
   * absent exactly when the arguments are present, so keying on id would drop
   * every fragment and yield `arguments: "{}"`.
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
      const fn = call["function_call"];
      const fnRecord = typeof fn === "object" && fn !== null ? (fn as Record<string, unknown>) : undefined;
      const name = typeof fnRecord?.["name"] === "string" ? (fnRecord["name"] as string) : undefined;
      const args = typeof fnRecord?.["arguments"] === "string" ? (fnRecord["arguments"] as string) : "";
      const declaredId = typeof call["id"] === "string" ? call["id"] : "";
      const index = typeof call["index"] === "number" ? call["index"] : 0;
      const slot = `idx:${index}`;

      if (declaredId.length > 0) {
        toolCallIds.set(slot, declaredId);
        // The closing frame repeats a known id with no payload; emitting it
        // again would append a duplicate empty call.
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

  /** Normalizes + cache-assesses one raw upstream usage frame, if any. */
  #assessUsage(
    usage: Record<string, unknown> | undefined,
    sessionId?: string,
    messages?: readonly CanonicalMessage[],
  ): UsageRecord | undefined {
    if (usage === undefined) return undefined;
    const record = usageFromProvider(usage);
    if (record === undefined) return undefined;
    // Trae's agent surface never reports prompt-cache hits; for repeated
    // prefixes we estimate them locally (see trae-cache.ts). Then the
    // operator's cache mode decides whether a hit makes the whole input count
    // as cached.
    return estimateTraeSessionCache(record, sessionId, messages);
  }

}

export function createTraeAdapter(options: TraeAdapterOptions = {}): ProviderAdapter {
  return new TraeAdapter(options);
}

/** Adapter for the China deployment: different host, auth scheme, and roster. */
export function createTraeCnAdapter(options: TraeAdapterOptions = {}): ProviderAdapter {
  return new TraeAdapter({
    ...options,
    realm: "cn",
    providerId: TRAE_CN_PROVIDER_ID,
  });
}

/**
 * Live model discovery.
 *
 * The source follows the realm, not one endpoint:
 *
 * - **intl** — the agent picker (`batch_get_detail_param` with
 *   `function: solo_agent`), filtered to `usage == "chat_completion"` rows.
 *   The chat `model_list` is NOT the intl source: it lists only the legacy
 *   nine chat ids, and an agent roster row (`gpt-5-paygo`,
 *   `deepseek-v4.1-flash`, `search_agent_*`, …) is absent from it (verified
 *   live 2026-11-06). Reading it would replace the agent catalog with models
 *   the agent surface rejects (`4023 model is unknown`).
 * - **CN** — the chat `model_list`, which is the surface that serves CN.
 *
 * The listing is per account region, not per realm: it answers on CN and on the
 * intl region host that serves the account (`coresg-normal.trae.ai` verified),
 * while the generic intl core answers `403 no schema found`. An empty result is
 * therefore a real "this account has no listing", and the static roster stays
 * the fallback rather than being replaced by nothing.
 */
export async function discoverTraeModels(input: {
  readonly realm: TraeRealm;
  readonly token: string;
  readonly uid: string;
  readonly fetcher: typeof fetch;
  readonly signal?: AbortSignal;
  readonly providerId?: string;
  /** Account region, so the listing is asked of the host that serves it. */
  readonly region?: string;
}): Promise<readonly {
  id: string;
  ctx: number | undefined;
}[]> {
  const headers = buildTraeHeaders({
    realm: input.realm,
    token: input.token,
    uid: input.uid,
    appVersion: getTraeVersion(),
  });
  const core = traeCoreForAccount(
    input.realm,
    input.region === undefined ? undefined : { region: input.region },
  );

  if (input.realm === "intl") {
    // The agent picker: the only surface that lists the intl roster's configs.
    const url = `${core}/api/ide/v1/batch_get_detail_param`;
    const response = await input.fetcher(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ functions: [TRAE_AGENT_FUNCTION], Request: {} }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!response.ok) return [];
    const parsed = (await response.json()) as { function_configs?: unknown };
    const groups = Array.isArray(parsed.function_configs) ? parsed.function_configs : [];
    const out: { id: string; ctx: number | undefined }[] = [];
    for (const group of groups) {
      if (typeof group !== "object" || group === null) continue;
      const list = (group as Record<string, unknown>)["config_info_list"];
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        if (typeof entry !== "object" || entry === null) continue;
        const row = entry as Record<string, unknown>;
        // Only chat-capable configs are dispatch targets; fast_apply,
        // title_generation, etc. are not.
        if (String(row["usage"] ?? "") !== "chat_completion") continue;
        const id = String(row["config_name"] ?? "").trim();
        if (id.length === 0) continue;
        // Context: the picker row carries `model_detail_list` with the real
        // upstream rows; prefer the widest selectable window among them.
        let ctx: number | undefined;
        const details = Array.isArray(row["model_detail_list"]) ? row["model_detail_list"] : [];
        for (const detail of details) {
          const w = traeMaxContextWindow(detail);
          if (w !== undefined && (ctx === undefined || w > ctx)) ctx = w;
        }
        out.push({ id, ctx });
      }
    }
    return out;
  }

  // CN: the chat roster surface.
  const url = `${core}${TRAE_MODEL_LIST_PATH}`;
  const response = await input.fetcher(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ type: "chat" }),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!response.ok) return [];
  const parsed = (await response.json()) as {
    data?: unknown;
    models?: unknown;
    model_configs?: unknown;
  };
  const rows = Array.isArray(parsed.model_configs)
    ? parsed.model_configs
    : Array.isArray(parsed.models)
      ? parsed.models
      : Array.isArray(parsed.data)
        ? parsed.data
        : [];
  return rows
    .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
    .map((row) => ({
      // `model_name` is the key upstream's listing uses; `name`/`id` are
      // spellings older snapshots assumed.
      id: String(row["model_name"] ?? row["name"] ?? row["id"] ?? "").trim(),
      ctx: traeMaxContextWindow(row),
    }))
    .filter((row) => row.id.length > 0);
}

export { TRAE_CN_MODELS, TRAE_INTL_MODELS };

/**
 * Core host for one account.
 *
 * An intl account is provisioned into a region and its token only authenticates
 * against that region's host, so the account's own `region` wins over the
 * realm default. Falling back to the realm keeps older accounts (stored before
 * the region was captured) working exactly as before.
 */
function traeCoreForAccount(
  realm: TraeRealm,
  authState: Readonly<Record<string, unknown>> | undefined,
): string {
  const region = typeof authState?.["region"] === "string" ? authState["region"].toLowerCase() : "";
  const regional = TRAE_REGION_CORE_HOSTS[region];
  if (regional !== undefined) return regional;
  return traeCoreCandidates(realm)[0] ?? "";
}
