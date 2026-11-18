/**
 * Dedicated `codex` adapter.
 *
 * Cartethyia's `codex` provider is ChatGPT-OAuth-family only: subscriber
 * OAuth, enterprise scoped access tokens, and workload-identity federation
 * all bill against the same ChatGPT plan credits and dispatch through the
 * same ChatGPT backend. Plain OpenAI API-key traffic is served by the
 * separate `openai` provider (`src/providers/integrations/openai.ts`) and never
 * reaches this adapter.
 *
 * Auth is consumed only from `context.credential`. Wire mechanics live in
 * `src/protocol/` plus provider-local modules:
 *   - `protocol/request/codex.ts`  — canonical → Codex Responses body + Responses Lite shape
 *   - `protocol/response/codex.ts` — Codex JSON → canonical events + SSE frame processor
 *   - `protocol/codecs.ts`     — tool-id encoding, Harmony escaping, ASCII JSON
 *   - `headers.ts`  — Codex identity headers + client/turn metadata
 *   - `errors.ts`   upstream HTTP error → `GatewayError`
 *   - `identity.ts` — Codex account / install / residency lookups
 *   - `retry.ts`   — 429 capacity-wait planning + rate-limit sleep override
 *   - `wire.ts`    — bearer auth headers, SSE sniffing, search citations
 *   - `session.ts` — bounded per-session state store (sticky routing)
 *
 * Bespoke by wire protocol (Phase C5): session/SSE protocol (Codex Responses
 * envelope, session headers, frame processor) is outside the
 * OpenAI-compatible factory's reach — stays bespoke, never re-audit.
 */
import type { CanonicalEvent, CanonicalRequest } from "../../../protocol/canonical-model";
import { GatewayError } from "../../../protocol/gateway-error";
import { getCodexVersion } from "../../operations/client-versions";
import { buildCodexUserAgent } from "../../operations/cli-platform";
import { randomUUID } from "node:crypto";
import { resolvePromptCacheKey } from "../../operations/session-resolution";
import { decodeSseEvents } from "../../../protocol/sse-decoder";
import { imageCreatedSeconds, imagePrompt, responsesImageResult } from "../../../protocol/image-generation";
import { isRecord, joinUrl } from "../../../protocol/codecs";
import { postUpstreamJson } from "../../../protocol/upstream/post-json";
import { assertWireFamily } from "../../provider-contracts";
import type { ImageGenerationOutcome, ProviderDispatchTarget, ProviderAdapter, ProviderDispatchContext, ResolvedCredential, WebSearchOutcome } from "../../provider-contracts";
import {
  createCodexIdentity,
  getCodexAccountId,
  getCodexInstallId,
  getCodexResidency,
} from "./codex-identity";
import { mapCodexErrorResponse } from "./codex-errors";
import {
  codex429WaitMs,
  codex429ServerDelayMs,
  sleep,
} from "./codex-retry";
import {
  authHeadersForCodex,
  normalizeCodexSearchCitations,
  sniffSseBody,
  CODEX_SEARCH_DEFAULT_MODEL,
} from "./codex-wire";
import { CodexSessionStore } from "./codex-session";
import {
  canonicalToCodexResponsesPayload,
  dropCodexAccessPrograms,
} from "../../../protocol/request/codex";
import {
  CodexStreamFrameProcessor,
  parseCodexResponsesJsonToEvents,
} from "../../../protocol/response/codex";
import {
  buildCodexIdentityHeaders,
  createCodexRequestMetadata,
} from "./codex-headers";
import type { CodexSessionState } from "../../../protocol/codecs";
import { DEFAULT_CHATGPT_BASE_URL } from "./codex-models";

// Model catalog and registry discovery live in `codex-models.ts`; re-exported
// here so every existing `codex/codex` importer keeps its module path.
export {
  CODEX_MODELS,
  CODEX_SEARCH_MODELS,
  buildCodexModelsUrl,
  discoverCodexModels,
} from "./codex-models";

// 429 capacity-wait planning and its test-overridable sleep live in
// `codex-retry.ts`; re-exported here so importers keep their module path.
export {
  _setCodexRateLimitSleepForTesting,
  codex429WaitMs,
} from "./codex-retry";

/** OAuth-family credential kinds accepted by the Codex adapter. */
export const CODEX_OAUTH_FAMILY_KINDS: readonly string[] = [
  "oauth",
  "scoped_access_token",
  "workload_identity",
];

/**
 * Enforces the OAuth-family credential contract at every Codex dispatch
 * boundary. Rejecting non-OAuth kinds here keeps routing, billing, and
 * upstream host selection single-valued and prevents the `codex` provider
 * ID from silently fanning API-key traffic to the ChatGPT backend.
 */
export function assertCodexOAuthCredential(
  credential: ResolvedCredential,
): void {
  if (
    !(CODEX_OAUTH_FAMILY_KINDS as readonly string[]).includes(
      credential.credential_kind,
    )
  ) {
    throw new GatewayError(
      "invalid_request",
      400,
      `codex: ChatGPT OAuth credential required (got credential_kind=${credential.credential_kind}) (request {requestId}). Wrong key, right door — check the credential 🔑`,
    );
  }
}

interface CodexAdapterConfig {
  readonly provider_id: "codex";
  /** ChatGPT backend base URL override (defaults to https://chatgpt.com). */
  readonly chatgpt_base_url?: string;
  /** Injected fetch for tests; defaults to global. */
  readonly fetch?: typeof fetch;
  /** Version stamped into User-Agent, e.g. "0.153.0". */
  readonly codex_cli_version?: string;
  /** Attestation token to emit as x-oai-attestation when required. */
  readonly attestation?: string;
  /**
   * Responses Lite transport marker. When true, the adapter applies the
   * Responses Lite body shape and emits the sibling
   * `x-openai-internal-codex-responses-lite` header. Callers / candidate
   * resolution must set this for lite-only models; defaults to false.
   */
  readonly responses_lite?: boolean;
  /**
   * When true, sends `x-codex-beta-features: remote_compaction_v2`.
   * Defaults to false — only set when the backend explicitly requires it.
   */
  readonly enable_remote_compaction_v2?: boolean;
  /**
   * Opt-in concurrent reasoning-summary delivery. When true and a reasoning
   * summary was requested, sends
   * `stream_options.reasoning_summary_delivery: "sequential_cutoff"`.
   * Defaults to false — codex-rs ships the mode under development because it
   * can cancel summary sections still in flight.
   */
  readonly concurrent_reasoning_summaries?: boolean;
  /**
   * Sub-agent context marker. When set, sends `x-openai-subagent`. No
   * automatic trigger in Cartethyia's CanonicalRequest/ProviderDispatchTarget today —
   * wiring is a no-op stub that only emits when explicitly set.
   */
  readonly subagent?: string;
  /**
   * Override for installation ID in tests. Bypasses file-based
   * `getCodexInstallId()`. Ignored in production paths that want the
   * on-disk value.
   */
  readonly installation_id_override?: string;
}

/** Native, non-streaming ChatGPT Responses compaction transport. */
export interface CodexCompactAdapter extends ProviderAdapter {
  compact(
    body: Record<string, unknown>,
    context: ProviderDispatchContext,
  ): Promise<Response>;
}

export function createCodexAdapter(
  config: CodexAdapterConfig,
): CodexCompactAdapter {
  const fetchFn = config.fetch ?? globalThis.fetch;
  const chatgptBase = config.chatgpt_base_url ?? DEFAULT_CHATGPT_BASE_URL;
  const version = (): string => config.codex_cli_version ?? getCodexVersion();
  const attestation = config.attestation;
  const responsesLite = config.responses_lite ?? false;
  const betaRemoteCompaction = config.enable_remote_compaction_v2 ?? false;
  const concurrentReasoningSummaries =
    config.concurrent_reasoning_summaries ?? false;
  const subAgent = config.subagent;
  const installationOverride = config.installation_id_override;

  // Per-session state for sticky routing (x-codex-turn-state) and identity
  // reuse. Bounded LRU + TTL (see `codex-session.ts`): an unbounded map
  // would leak memory forever under a long-running process serving many
  // distinct Codex sessions.
  const sessionStates = new CodexSessionStore(2000, 60 * 60 * 1000);

  function getSessionState(id: string): CodexSessionState | undefined {
    return sessionStates.get(id);
  }

  function setSessionState(id: string, state: CodexSessionState): void {
    sessionStates.set(id, state);
  }

  let cachedInstallationId: string | undefined = installationOverride;
  let installationIdPromise: Promise<string> | undefined;

  async function getInstallationIdCached(): Promise<string> {
    if (cachedInstallationId !== undefined && cachedInstallationId.length > 0)
      return cachedInstallationId;
    if (installationIdPromise !== undefined) return installationIdPromise;
    installationIdPromise = (async () => {
      if (
        installationOverride !== undefined &&
        installationOverride.length > 0
      ) {
        cachedInstallationId = installationOverride;
        return installationOverride;
      }
      try {
        const id = await getCodexInstallId();
        cachedInstallationId = id;
        return id;
      } catch {
        const fallback = randomUUID();
        cachedInstallationId = fallback;
        return fallback;
      }
    })();
    const id = await installationIdPromise;
    installationIdPromise = undefined;
    return id;
  }

  function captureSessionHeadersFromResponse(
    sessionId: string | undefined,
    headers: Headers | Record<string, string> | null | undefined,
  ): void {
    if (
      sessionId === undefined ||
      sessionId.length === 0 ||
      headers === null ||
      headers === undefined
    )
      return;
    const state = getSessionState(sessionId);
    if (state === undefined) return;
    let turnState: string | null = null;
    if (headers instanceof Headers) {
      turnState = headers.get("x-codex-turn-state");
    } else if (typeof headers === "object") {
      const rec = headers as Record<string, string>;
      for (const [k, v] of Object.entries(rec)) {
        const lower = k.toLowerCase();
        if (lower === "x-codex-turn-state") turnState = v;
      }
    }
    if (
      turnState !== null &&
      turnState.length > 0 &&
      (state.turnState === undefined || state.turnState.length === 0)
    ) {
      state.turnState = turnState;
    }
  }

  return {
    provider_id: "codex" as const,
    async compact(
      body: Record<string, unknown>,
      context: ProviderDispatchContext,
    ): Promise<Response> {
      assertCodexOAuthCredential(context.credential);
      const installationId = await getInstallationIdCached();
      const identity = createCodexIdentity();
      const token =
        context.credential.secret === undefined
          ? undefined
          : new TextDecoder().decode(context.credential.secret);
      const residency =
        token === undefined
          ? undefined
          : getCodexResidency({ accessToken: token });
      const { turnMetadataJson } = createCodexRequestMetadata({
        installationId,
        sessionId: identity.session_id,
        threadId: identity.thread_id,
        windowId: identity.window_id,
        turnId: identity.turn_id,
        requestKind: "compaction",
      });
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json",
        ...authHeadersForCodex(context.credential),
        ...buildCodexIdentityHeaders({
          credential: context.credential,
          version: version(),
          attestation,
          residency,
          sessionId: identity.session_id,
          threadId: identity.thread_id,
          windowId: identity.window_id,
          turnMetadataJson,
          betaFeatures: betaRemoteCompaction
            ? "remote_compaction_v2"
            : undefined,
        }),
      };
      const { res, release } = await postUpstreamJson(
        joinUrl(chatgptBase, "/backend-api/codex/responses/compact"),
        headers,
        body,
        context,
        context.outbound_fetch ?? fetchFn,
      );
      try {
        if (!res.ok) await mapCodexErrorResponse(res);
        const responseBody = await res.json();
        return Response.json(responseBody, {
          status: res.status,
          headers: { "cache-control": "no-store" },
        });
      } finally {
        release();
      }
    },
    async websearch(
      body: Record<string, unknown>,
      candidate: ProviderDispatchTarget,
      context: ProviderDispatchContext,
    ): Promise<WebSearchOutcome> {
      const query = typeof body.query === "string" ? body.query.trim() : "";
      if (!query) throw new GatewayError("invalid_request", 400, "search query is required (request {requestId}). Check the shape of what you sent — then resend 🪞");
      const requested = typeof body.model === "string" ? body.model.trim() : "";
      const model = requested.length > 0 && requested !== "codex" ? requested : CODEX_SEARCH_DEFAULT_MODEL;
      const request: CanonicalRequest = {
        model,
        messages: [{ role: "user", content: [{ kind: "text", text: query }] }],
        tools: [{ name: "web_search", tool_type: "web_search", jsonSchema: {} }],
        generation_controls: { max_output_tokens: 1024 },
        provider_options: { capture_web_search_citations: true },
        stream: false,
        source_surface: "responses",
      };
      const citations: unknown[] = [];
      let answerText = "";
      for await (const event of this.dispatch(request, candidate, context)) {
        if (event.type !== "content_delta") continue;
        if (event.content.kind === "text") answerText += event.content.text;
        if (event.content.kind === "extension" && event.content.name === "web_search_citations") {
          const payload = event.content.payload;
          if (Array.isArray(payload)) {
            citations.push(...payload);
          } else if (payload && typeof payload === "object" && !Array.isArray(payload)) {
            const record = payload as Record<string, unknown>;
            if (Array.isArray(record.annotations)) citations.push(...record.annotations);
            else citations.push(record);
            if (typeof record.text === "string" && answerText.length === 0) answerText = record.text;
          }
        }
      }
      const results = normalizeCodexSearchCitations(citations, answerText);
      if (results.length === 0)
        throw new GatewayError("platform_unavailable", 502, "Codex search returned no citations (request {requestId}). The upstream came back empty-handed — retry 🌙");
      const rawMax = body.max_results;
      const maxResults =
        typeof rawMax === "number" && Number.isFinite(rawMax)
          ? Math.min(Math.max(1, Math.floor(rawMax)), 50)
          : 10;
      return { results: results.slice(0, maxResults), total_results: Math.min(results.length, maxResults) };
    },
    async generateImage(
      body: Record<string, unknown>,
      candidate: ProviderDispatchTarget,
      context: ProviderDispatchContext,
    ): Promise<ImageGenerationOutcome> {
      assertCodexOAuthCredential(context.credential);
      const prompt = imagePrompt(body);
      const requested =
        candidate.model_id.length > 0 ? candidate.model_id : typeof body.model === "string" ? body.model : "";
      if (requested.length === 0) throw new GatewayError("invalid_request", 400, "model is required (request {requestId}). Check the shape of what you sent — then resend 🪞");
      // A `-image` id is the chat model with the suffix removed. Dedicated
      // image tools still need a chat carrier, and the account's visible 5.6
      // models are the current ones.
      const toolModel = requested.endsWith("-image") ? undefined : requested;
      const carrier = toolModel === undefined ? requested.slice(0, -"-image".length) : "gpt-5.6-terra";
      const outputFormat = typeof body.output_format === "string" && body.output_format.length > 0
        ? body.output_format.toLowerCase()
        : "png";
      const tool: Record<string, unknown> = {
        type: "image_generation",
        action: "generate",
        output_format: outputFormat,
        ...(typeof body.size === "string" && body.size.length > 0 ? { size: body.size } : {}),
        ...(typeof body.quality === "string" && body.quality.length > 0 ? { quality: body.quality } : {}),
        ...(toolModel === undefined ? {} : { model: toolModel }),
      };
      const identity = createCodexIdentity();
      const token = new TextDecoder().decode(context.credential.secret ?? new Uint8Array());
      const residency = token.length === 0 ? undefined : getCodexResidency({ accessToken: token });
      const accountId = context.credential.account_id ?? (token.length === 0 ? undefined : getCodexAccountId(token));
      // Hosted image generation is not a Codex chat turn. Do not reuse the chat
      // identity envelope: turn metadata, routing hints, and client metadata
      // belong to the agentic text path and make this endpoint drop `tools`.
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...authHeadersForCodex(context.credential),
        "user-agent": buildCodexUserAgent(version()),
        originator: "codex_cli_rs",
        version: version(),
        "OpenAI-Beta": "responses=experimental",
        session_id: identity.session_id,
        conversation_id: identity.session_id,
        ...(accountId === undefined || accountId.length === 0 ? {} : { "chatgpt-account-id": accountId }),
        ...(residency === undefined || residency.length === 0
          ? {}
          : { "x-openai-internal-codex-residency": residency }),
      };
      const payload: Record<string, unknown> = {
        model: carrier,
        instructions:
          "You are an AI image generator. Generate images based on user descriptions. Focus on creating high-quality, visually appealing images that match the user's request.",
        input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
        tools: [tool],
        // The hosted image contract names the tool. A string choice is the chat
        // contract and is rejected here once the chat envelope is absent.
        tool_choice: { type: "image_generation" },
        store: false,
        stream: true,
      };
      const endpointPath = candidate.endpoint_path.length > 0 ? candidate.endpoint_path : "/backend-api/codex/responses";
      const { res, release } = await postUpstreamJson(
        joinUrl(chatgptBase, endpointPath),
        headers,
        payload,
        context,
        context.outbound_fetch ?? fetchFn,
      );
      try {
        if (!res.ok) await mapCodexErrorResponse(res);
        let image: string | undefined;
        for await (const event of decodeSseEvents(res.body, {
          signal: context.abort_signal,
          maxEventBytes: 32 * 1024 * 1024,
        })) {
          const data = event.data.trim();
          if (data.length === 0 || data === "[DONE]") continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            throw new GatewayError("platform_unavailable", 502, "Codex image stream returned malformed JSON (request {requestId}). The upstream came back empty-handed — retry 🌙", {}, "upstream");
          }
          if (isRecord(parsed) && (parsed.type === "error" || parsed.type === "response.failed")) {
            const message = isRecord(parsed.error) && typeof parsed.error.message === "string"
              ? parsed.error.message
              : isRecord(parsed.response) && isRecord(parsed.response.error) && typeof parsed.response.error.message === "string"
                ? parsed.response.error.message
                : "Codex image generation failed";
            throw new GatewayError("platform_unavailable", 502, `${message} (request {requestId}). The upstream came back empty-handed — retry 🌙`, {}, "upstream");
          }
          image = responsesImageResult(parsed) ?? image;
        }
        if (image === undefined) {
          throw new GatewayError(
            "platform_unavailable",
            502,
            "Codex did not return an image. Account may not be entitled.",
            {},
            "upstream",
          );
        }
        return { created: imageCreatedSeconds(), data: [{ b64_json: image }] };
      } finally {
        release();
      }
    },
    async *dispatch(
      request: CanonicalRequest,
      candidate: ProviderDispatchTarget,
      context: ProviderDispatchContext,
    ): AsyncIterable<CanonicalEvent> {
      if (candidate.provider_id !== "codex") {
        throw new GatewayError(
          "invalid_request",
          400,
          "codex adapter received non-codex candidate (request {requestId}). Even we have bad days — check the registry wiring 🐻",
        );
      }
      if (candidate.wire_family !== "responses") {
        assertWireFamily(candidate, "responses", "codex");
      }
      if (request.model.includes("?")) {
        throw new GatewayError(
          "invalid_request",
          400,
          "model must not contain query string (request {requestId}). Check the shape of what you sent — then resend 🪞",
        );
      }

      assertCodexOAuthCredential(context.credential);

      const endpointPath =
        candidate.endpoint_path.length > 0
          ? candidate.endpoint_path
          : "/backend-api/codex/responses";
      const url = joinUrl(chatgptBase, endpointPath);

      const nonEmpty = (value: string | undefined): string | undefined =>
        value === undefined || value.length === 0 ? undefined : value;
      let rawSessionId = nonEmpty(request.session_id) ?? resolvePromptCacheKey(request, context);
      let rawThreadId = nonEmpty(request.thread_id);
      let rawWindowId = nonEmpty(request.window_id);
      let rawTurnId = nonEmpty(request.turn_id);
      const rawParentTurnId = nonEmpty(request.parent_turn_id);

      const installationId = await getInstallationIdCached();

      // Ensure a session state entry for this session so subsequent turns
      // can carry sticky routing headers.
      let effectiveSessionId: string;
      let sessionState: CodexSessionState;
      if (rawSessionId !== undefined && rawSessionId.length > 0) {
        effectiveSessionId = rawSessionId;
        const existing = getSessionState(effectiveSessionId);
        if (existing !== undefined) {
          sessionState = existing;
          if (rawThreadId !== undefined && rawThreadId.length > 0)
            sessionState.threadId = rawThreadId;
          if (rawWindowId !== undefined && rawWindowId.length > 0)
            sessionState.windowId = rawWindowId;
        } else {
          const threadId = rawThreadId ?? randomUUID();
          const windowId = rawWindowId ?? randomUUID();
          sessionState = {
            sessionId: effectiveSessionId,
            threadId,
            windowId,
          };
          setSessionState(effectiveSessionId, sessionState);
        }
      } else {
        // Missing session identity receives a fresh request-local identity so
        // every request has a complete client-metadata envelope.
        const identity = createCodexIdentity();
        effectiveSessionId = identity.session_id;
        rawSessionId = effectiveSessionId;
        rawThreadId = rawThreadId ?? identity.thread_id;
        rawWindowId = rawWindowId ?? identity.window_id;
        rawTurnId = rawTurnId ?? identity.turn_id;
        sessionState = {
          sessionId: effectiveSessionId,
          threadId: rawThreadId,
          windowId: rawWindowId,
        };
        setSessionState(effectiveSessionId, sessionState);
      }
      const threadId = rawThreadId ?? sessionState.threadId;
      const windowId = rawWindowId ?? sessionState.windowId;
      const turnId = rawTurnId ?? randomUUID();
      sessionState.threadId = threadId;
      sessionState.windowId = windowId;
      const turnStartedAtUnixMs = Date.now();
      sessionState.turnStartedAtUnixMs = turnStartedAtUnixMs;

      const token =
        context.credential.secret === undefined
          ? undefined
          : new TextDecoder().decode(context.credential.secret);
      const residency =
        nonEmpty(request.residency) ??
        (token === undefined
          ? undefined
          : getCodexResidency({ accessToken: token }));

      const { clientMetadata, turnMetadataJson } =
        createCodexRequestMetadata({
          installationId,
          sessionId: effectiveSessionId,
          threadId,
          windowId,
          turnId,
          ...(rawParentTurnId === undefined
            ? {}
            : { parentTurnId: rawParentTurnId }),
          turnStartedAtUnixMs,
        });
      const betaFeatures = betaRemoteCompaction
        ? "remote_compaction_v2"
        : undefined;

      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "text/event-stream",
      };
      Object.assign(headers, authHeadersForCodex(context.credential));
      Object.assign(
        headers,
        buildCodexIdentityHeaders({
          credential: context.credential,
          version: version(),
          attestation,
          residency,
          sessionId: effectiveSessionId,
          threadId,
          windowId,
          turnMetadataJson,
          betaFeatures,
          subAgent,
          responsesLite,
          turnState: sessionState.turnState,
        }),
      );
      const outboundFetch = context.outbound_fetch ?? fetchFn;
      const payload = canonicalToCodexResponsesPayload(request, {
        responsesLite,
        concurrentReasoningSummaries,
      });
      // Codex prompt caching is routed by a stable per-session key. The
      // official client sends this key on every Responses request; relying on
      // an optional inbound cache hint leaves Model Lab sessions uncached.
      payload["prompt_cache_key"] = effectiveSessionId;
      // The session key alone buys only the default retention. When the caller
      // declares a retention via `codex_prompt_cache_retention`, thread it
      // alongside the key (reference `prompt_cache_retention` passthrough);
      // a backend that does not know the field ignores it.
      const retention = request.provider_options?.["codex_prompt_cache_retention"];
      if (retention === "in_memory" || retention === "24h") {
        payload["prompt_cache_retention"] = retention;
      }
      payload["client_metadata"] = clientMetadata;

      let waitedOnRateLimitMs = 0;
      let rateLimitRetry = 0;
      let { res, release } = await postUpstreamJson(
        url,
        headers,
        payload,
        context,
        outboundFetch,
      );
      try {
      // 429 → wait the delay the upstream stated and re-post the same request
      // (research item Codex #2). A transient quota/overload is latency, not a
      // terminal error: honoring the stated delay turns it into a slow success
      // instead of a `quota_exceeded` the client has to retry itself.
      //
      // Bounded three ways so it can never stall the attempt: a 5-minute total
      // wait budget, one 60s cap per wait, and the request deadline (a re-post
      // needs `MIN_RETRY_BUDGET_MS` left to be worth starting). When none of
      // those leave room, the 429 surfaces as it always did.
      while (res.status === 429) {
        const waitMs = codex429WaitMs({
          serverDelayMs: codex429ServerDelayMs(res),
          waitedMs: waitedOnRateLimitMs,
          retry: rateLimitRetry,
          deadline: context.deadline,
          now: Date.now(),
        });
        if (waitMs === null) break;
        await res.body?.cancel().catch(() => undefined);
        release();
        try {
          await sleep(waitMs, context.abort_signal);
        } catch {
          // Aborted while waiting out the window: report the 429 we already
          // hold, so the client sees the rate limit rather than a bare cancel.
          await mapCodexErrorResponse(res);
        }
        // Count what was actually waited, not what was planned: the sleep can
        // return early on abort, and the planner reads this as spent budget.
        waitedOnRateLimitMs += waitMs;
        rateLimitRetry += 1;
        const retried = await postUpstreamJson(
          url,
          headers,
          payload,
          context,
          outboundFetch,
        );
        res = retried.res;
        release = retried.release;
      }
      // Daybreak access-program rejection → drop the field and replay once
      // (donor `access-programs.ts:32-63`). UNCONFIRMED: the recovery is
      // transcribed from the donor implementation alone — no capture here
      // shows the upstream rejecting this field, so the replay is bounded to
      // one attempt and only fires when the attempted request actually
      // carried `access_programs`. An ineligible account therefore hard-fails
      // on the second response instead of looping: the error that surfaces is
      // the mapped rejection from the replay, never a retry-exhaustion error.
      if (!res.ok && dropCodexAccessPrograms(payload)) {
        await res.body?.cancel().catch(() => undefined);
        release();
        const replayed = await postUpstreamJson(
          url,
          headers,
          payload,
          context,
          outboundFetch,
        );
        res = replayed.res;
        release = replayed.release;
      }
      if (!res.ok) {
        await mapCodexErrorResponse(res);
      }

      captureSessionHeadersFromResponse(effectiveSessionId, res.headers);

      const contentType = res.headers.get("content-type") ?? "";
      // ChatGPT Codex omits content-type and always speaks SSE, including
      // when the client asked for JSON. Reading the whole clone to sniff the
      // type waits for the upstream to finish. Peek only the first frame.
      const typedSse = contentType.toLowerCase().includes("text/event-stream");
      const sniffed = typedSse || request.stream === true ? undefined : await sniffSseBody(res.body);
      const body = sniffed?.body ?? res.body;
      const isSse = typedSse || request.stream === true || sniffed?.sse === true;
      if (isSse) {
        const processor = new CodexStreamFrameProcessor(
          2,
          request.provider_options?.capture_web_search_citations === true,
        );
        const respId = `codex_${Date.now()}`;
        yield {
          type: "response_start",
          sequence_number: 1,
          event_id: respId,
          model: request.model,
        } as CanonicalEvent;
        for await (const sse of decodeSseEvents(body, {
          signal: context.abort_signal,
        })) {
          const data = sse.data.trim();
          // [DONE] ends the stream: break without waiting for TCP close so
          // gated upstreams (close depends on our terminal) cannot deadlock.
          if (data === "[DONE]") break;
          if (data.length === 0) continue;
          try {
            const json = JSON.parse(data) as Record<string, unknown>;
            if (
              json["type"] === "response.metadata" &&
              typeof json["headers"] === "object"
            ) {
              captureSessionHeadersFromResponse(
                effectiveSessionId,
                json["headers"] as Record<string, string>,
              );
            }
            for (const ev of processor.process(json)) yield ev;
          } catch (error: unknown) {
            // A typed upstream error is already classified — rethrow it so its
            // code (quota, overload, context length) survives instead of being
            // rewritten as a malformed-SSE failure.
            if (error instanceof GatewayError) throw error;
            // A corrupt line is a corrupt stream, not a short success:
            // fail exactly like the chat/responses decoders (502) instead
            // of silently decoding truncated output as complete.
            throw new GatewayError(
              "platform_unavailable",
              502,
              error instanceof Error
                ? `Malformed SSE event: ${error.message} (request {requestId}). The upstream sent something we can't read — retry 🌙`
                : `Malformed SSE event (request {requestId}). The upstream sent something we can't read — retry 🌙`,
              {},
              "upstream",
            );
          }
        }
        // Reconcile tool calls whose completion frames never arrived before the
        // terminal is emitted, so a `tool_use` stop always has a visible block.
        for (const ev of processor.preTerminalEvents()) yield ev;
        yield processor.terminalEvent();
      } else {
        const json = JSON.parse(await new Response(body).text()) as Record<string, unknown>;
        if (typeof json["headers"] === "object" && json["headers"] !== null) {
          captureSessionHeadersFromResponse(
            effectiveSessionId,
            json["headers"] as Record<string, string>,
          );
        }
        const events = parseCodexResponsesJsonToEvents(json, request);
        for (const ev of events) yield ev;
      }
      } finally {
        release();
      }
    },
  };
}
