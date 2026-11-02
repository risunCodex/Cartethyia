/**
 * GitHub Copilot adapter.
 *
 * Copilot is an OpenAI-compatible chat surface, but not a fixed one: the API
 * host is per-account and is read out of the Copilot token's `proxy-ep` claim,
 * so an Individual account and an enterprise account post to different hosts.
 * That is why this is a bespoke adapter rather than a declarative spec — the
 * `base_url` a spec carries is fixed at registration, and the routing layer
 * resolves one base URL per provider, not per account.
 *
 * The credential is a `{access, apiHost}` envelope for the same reason the
 * host is not a constant: the value stored at login is the only place the
 * account's host is recorded.
 */
import { createHash, randomUUID } from "node:crypto";
import { defineModel } from "../../provider-model-definition";
import type { ModelDefinition } from "../../provider-model-definition";
import type { ProviderAdapter, ProviderDispatchContext, ProviderDispatchTarget } from "../../provider-contracts";
import { GatewayError } from "../../../protocol/gateway-error";
import { isRecord } from "../../../protocol/codecs";
import { mapUpstreamHttpError } from "../../../transport/failure-policy";
import { allParts, type CanonicalEvent, type CanonicalRequest, type ContentPart } from "../../../protocol/canonical-model";
import { OpenAICompatibleAdapter, withBearerAuthentication } from "../../adapters/compatible-adapter";
import { postUpstreamJson } from "../../../protocol/upstream/post-json";
import { providerBaseUrl } from "../../provider-metadata";
import { getOrCreateInstallId } from "../shared/install-id";
import { resolveRedisClient } from "../../../persistence/redis";
import { applyParamQuirks } from "../../../protocol/translation/quirks";
import { resolveInboundSessionId } from "../../operations/session-resolution";
import {
  GITHUB_REQUEST_HEADERS,
  parseGithubCredential,
} from "./github-oauth";

export const GITHUB_PROVIDER_ID = "github" as const;

/** Chat surface. The static fallback rows are all chat. */
export const GITHUB_ENDPOINT_PATH = "/chat/completions" as const;

/**
 * Responses surface. Copilot serves some SKUs only on `/responses`, so a
 * discovered row declares this path and the shared pipeline routes the request
 * here rather than failing on the chat endpoint.
 */
export const GITHUB_RESPONSES_ENDPOINT_PATH = "/responses" as const;

/**
 * Anthropic Messages surface. Copilot serves the premium Claude family
 * (`claude-sonnet-*`, `claude-opus-*`, `claude-haiku-*`, `claude-fable-*`)
 * on the native `/v1/messages` wire, and some SKUs are messages-only. The
 * adapter's shared pipeline already speaks the messages codec; this constant
 * lets discovery route those rows here instead of dropping them.
 */
export const GITHUB_MESSAGES_ENDPOINT_PATH = "/v1/messages" as const;



/**
 * The highest reasoning effort Copilot serves as a fallback when a model does
 * not declare its own ladder. A caller asking for `max` or `xhigh` is answered
 * at `high` rather than refused: the model has no level above it, and the
 * request is otherwise valid.
 */
const GITHUB_REASONING_EFFORT_CAP = "high";
const GITHUB_CAPPED_EFFORTS = new Set(["max", "xhigh"]);

/**
 * Rewrites an effort above Copilot's ceiling to the highest level we know the
 * model accepts. The shared encoder already pinned the effort to the model's
 * declared ladder (`resolveSupportedReasoningEfforts` reads `reasoningEfforts`
 * from the catalog); this hook only guards a bare fallback so a caller asking
 * for `max`/`xhigh` on a model without a declared ladder is answered at `high`
 * rather than refused.
 */
function clampGithubReasoningEffort(payload: Record<string, unknown>): void {
  const effort = payload["reasoning_effort"];
  if (typeof effort === "string" && GITHUB_CAPPED_EFFORTS.has(effort)) {
    payload["reasoning_effort"] = GITHUB_REASONING_EFFORT_CAP;
  }
  const reasoning = payload["reasoning"];
  if (!isRecord(reasoning)) return;
  const nested = reasoning["effort"];
  if (typeof nested === "string" && GITHUB_CAPPED_EFFORTS.has(nested)) {
    payload["reasoning"] = { ...reasoning, effort: GITHUB_REASONING_EFFORT_CAP };
  }
}


/** Supported virtual Copilot Auto catalog ids and their router tiers. */
export const GITHUB_AUTO_MODEL_TIERS: ReadonlyMap<string, "efficiency" | "balance" | "intelligence"> = new Map([
  ["auto", "balance"],
  ["gpt-6-luna", "efficiency"],
]);

/** Copilot model ids excluded from both the fallback and discovered catalogs. */
export const GITHUB_EXCLUDED_MODEL_IDS: ReadonlySet<string> = new Set([
  "copilot-search-c",
  "exec-agent-a",
  "exec-agent-b",
  "exec-agent-c",
  "gpt-5.4-mini-free-auto",
  "gpt-5.6-luna",
  "gpt-5.6-luna-free-auto",
  "gpt-6-luna-low",
  "gpt-6-luna-medium",
  "gpt-6-luna-high",
  "kimi-k3",
]);

const modelRoutesByCredential = new Map<string, ReadonlyMap<string, GithubModelRoute>>();

/**
 * Shared route-map window. Discovery is per account and infrequent, so a short
 * shared entry lets a peer instance route a credential without re-running
 * discovery. Keyed by the credential hash already computed below, so no
 * credential material reaches the cache value.
 */
const GITHUB_ROUTE_TTL_SECONDS = 300;
const GITHUB_ROUTE_KEY_PREFIX = "github:routes:v1:";

function serializeRouteMap(routes: ReadonlyMap<string, GithubModelRoute>): string {
  return JSON.stringify([...routes]);
}

function parseRouteMap(raw: string): Map<string, GithubModelRoute> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const map = new Map<string, GithubModelRoute>();
    for (const entry of parsed) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [modelId, route] = entry as [unknown, unknown];
      if (typeof modelId !== "string" || route === null || typeof route !== "object") continue;
      const wireFamily = (route as { wireFamily?: unknown }).wireFamily;
      const endpointPath = (route as { endpointPath?: unknown }).endpointPath;
      if (
        (wireFamily === "chat" || wireFamily === "responses" || wireFamily === "messages") &&
        typeof endpointPath === "string"
      ) {
        map.set(modelId, { wireFamily, endpointPath });
      }
    }
    return map.size > 0 ? map : undefined;
  } catch {
    return undefined;
  }
}

async function readSharedModelRoutes(key: string): Promise<Map<string, GithubModelRoute> | undefined> {
  const redis = resolveRedisClient();
  if (!redis) return undefined;
  try {
    const hit = await redis.get(`${GITHUB_ROUTE_KEY_PREFIX}${key}`);
    return hit === null ? undefined : parseRouteMap(hit);
  } catch {
    return undefined;
  }
}

async function writeSharedModelRoutes(
  key: string,
  routes: ReadonlyMap<string, GithubModelRoute>,
): Promise<void> {
  const redis = resolveRedisClient();
  if (!redis) return;
  try {
    await redis.set(
      `${GITHUB_ROUTE_KEY_PREFIX}${key}`,
      serializeRouteMap(routes),
      "EX",
      GITHUB_ROUTE_TTL_SECONDS,
    );
  } catch {
    // Shared visibility only; the local map stays authoritative.
  }
}

export interface GithubModelRoute {
  readonly wireFamily: "chat" | "responses" | "messages";
  readonly endpointPath: string;
}
const GITHUB_AUTO_SESSION_CACHE_MAX_ENTRIES = 50;
const GITHUB_AUTO_SESSION_EXPIRY_SKEW_MS = 5 * 60 * 1_000;

function githubCredentialKey(value: string): string | undefined {
  try {
    const credential = parseGithubCredential(value);
    return createHash("sha256")
      .update(`${credential.apiHost}:${credential.github ?? credential.access}`)
      .digest("hex");
  } catch {
    return undefined;
  }
}
/** Replaces this account's discovered model-to-endpoint routing map. */
export function recordGithubModelRoutes(
  credential: string,
  models: readonly ModelDefinition[],
): void {
  const key = githubCredentialKey(credential);
  if (key === undefined) return;
  const routes = models
    .filter(
      (model): model is ModelDefinition & { readonly wireFamily: "chat" | "responses" | "messages" } =>
        model.wireFamily === "chat" || model.wireFamily === "responses" || model.wireFamily === "messages",
    )
    .map((model) => [
      model.modelId.toLowerCase(),
      { wireFamily: model.wireFamily, endpointPath: model.endpointPath },
    ] as const);
  const routeMap = new Map(routes);
  modelRoutesByCredential.set(key, routeMap);
  // Publish for peer instances without blocking discovery on the write.
  void writeSharedModelRoutes(key, routeMap);
}

/** Looks up an inference surface reported by this account's model directory. */
export async function githubModelRoute(
  modelId: string,
  credential: string,
): Promise<GithubModelRoute | undefined> {
  const key = githubCredentialKey(credential);
  if (key === undefined) return undefined;
  const local = modelRoutesByCredential.get(key);
  if (local !== undefined) return local.get(modelId.toLowerCase());
  const shared = await readSharedModelRoutes(key);
  if (shared === undefined) return undefined;
  modelRoutesByCredential.set(key, shared);
  return shared.get(modelId.toLowerCase());
}

function isAgentInitiated(request: CanonicalRequest): boolean {
  const lastMessage = request.messages.at(-1);
  if (!lastMessage) return false;
  if (lastMessage.role === "assistant" || lastMessage.role === "tool") return true;
  return lastMessage.content.length > 0 &&
    lastMessage.content.every((part) => part.kind === "toolResult");
}

function containsImage(part: ContentPart): boolean {
  if (part.kind === "image") return true;
  return part.kind === "toolResult" &&
    Array.isArray(part.content) &&
    part.content.some(containsImage);
}

function autoPromptPart(part: ContentPart): string {
  switch (part.kind) {
    case "text":
    case "refusal":
      return part.text;
    case "toolCall":
      return `Tool call ${part.name}: ${JSON.stringify(part.arguments)}`;
    case "toolResult":
      return typeof part.content === "string"
        ? part.content
        : part.content.map(autoPromptPart).filter(Boolean).join("\n");
    case "image":
      return "[image attached]";
    case "file":
      return `[file${part.filename ? `: ${part.filename}` : ""}]`;
    case "document":
      return `[document${part.title ? `: ${part.title}` : ""}]`;
    case "audio":
      return "[audio attached]";
    case "reasoning":
      return part.summary ?? "";
    case "extension":
      return "";
    default: {
      const exhaustive: never = part;
      return exhaustive;
    }
  }
}

interface GithubAutoPrompt {
  readonly prompt: string;
  readonly hasImage: boolean;
}

function autoPrompt(request: CanonicalRequest): GithubAutoPrompt {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message?.role !== "user") continue;
    const parts = message.content.filter(
      (part) => part.kind !== "toolCall" && part.kind !== "toolResult" &&
        part.kind !== "reasoning" && part.kind !== "extension",
    );
    const prompt = parts.map(autoPromptPart).filter(Boolean).join("\n");
    if (prompt.length === 0) continue;
    return {
      prompt,
      hasImage: parts.some(containsImage),
    };
  }
  return { prompt: "", hasImage: false };
}

interface GithubAutoDecision {
  readonly modelId: string;
  readonly sessionToken: string;
  readonly expiresAt: number;
  readonly hasImage: boolean;
  readonly route?: GithubModelRoute;
}

function routeFromAutoModel(value: unknown): GithubModelRoute | undefined {
  if (!isRecord(value) || !Array.isArray(value["supported_endpoints"])) return undefined;
  const endpoints = new Set(
    value["supported_endpoints"]
      .filter((endpoint): endpoint is string => typeof endpoint === "string")
      .map((endpoint) => endpoint.replace(/^\/v1(?=\/)/, "")),
  );
  if (endpoints.has("/chat/completions")) {
    return { wireFamily: "chat", endpointPath: GITHUB_ENDPOINT_PATH };
  }
  if (endpoints.has("/responses")) {
    return { wireFamily: "responses", endpointPath: GITHUB_RESPONSES_ENDPOINT_PATH };
  }
  if (endpoints.has("/messages")) {
    return { wireFamily: "messages", endpointPath: GITHUB_MESSAGES_ENDPOINT_PATH };
  }
  return undefined;
}

interface CopilotModelOptions {
  readonly vision?: boolean;
  readonly reasoning?: boolean;
}

function copilotModel(
  modelId: string,
  contextLimit: number,
  outputLimit: number,
  options: CopilotModelOptions = {},
): ModelDefinition {
  return defineModel({
    id: modelId,
    providerId: GITHUB_PROVIDER_ID,
    wireFamily: "chat",
    endpoint: GITHUB_ENDPOINT_PATH,
    ctx: contextLimit,
    out: outputLimit,
    vision: options.vision ?? false,
    reasoning: options.reasoning ?? false,
    toolCall: true,
  });
}

export const GITHUB_AUTO_MODELS: readonly ModelDefinition[] = [
  ...[...GITHUB_AUTO_MODEL_TIERS.keys()].map((modelId) =>
    copilotModel(modelId, 1_000_000, 64_192, { vision: true, reasoning: true }),
  ),
];

/**
 * Static fallback catalog.
 *
 * The authoritative list is the account's own `/models` response, which reports
 * exactly which SKUs the subscription may use — so this list is the offline
 * floor, not the truth. It includes models verified reachable on the
 * `vscode-chat` integration. Models that failed reachability checks or are
 * still being tested are deliberately excluded. Limits come from the models.dev
 * base catalog where it knows the id (the ids here are the upstream vendors'
 * own).
 */
export const GITHUB_MODELS: readonly ModelDefinition[] = [
  ...GITHUB_AUTO_MODELS,
  copilotModel("gpt-4.1", 128_000, 32_768, { vision: true }),
  copilotModel("gpt-4o", 128_000, 16_384, { vision: true }),
  copilotModel("gpt-4o-mini", 128_000, 16_384, { vision: true }),
  copilotModel("gpt-3.5-turbo-0613", 16_385, 4_096),
  // Fireworks-hosted agent SKUs. `billing.restricted_to` on the account's own
  // catalog includes `free`, so they are usable without a paid plan.
  copilotModel("copilot-search-a", 260_000, 16_000),
  copilotModel("copilot-search-b", 260_000, 16_000),
];

/**
 * Adapter that derives its host and headers from the stored credential.
 *
 * `prepareHeaders` and the URL are both corrected rather than rebuilt: payload
 * translation, transport, SSE decoding, and error mapping stay with the shared
 * pipeline, so only the two Copilot-specific facts (the host and the client
 * identity) are supplied here.
 */
class GithubAdapter extends OpenAICompatibleAdapter {
  readonly #fallbackBaseUrl: string;
  /**
   * Transport seam, held here because this adapter issues its own request: the
   * shared config's `fetch` is private, and ignoring it would send a test's
   * injected transport to the real network.
   */
  readonly #fetch: typeof fetch | undefined;
  readonly #autoSessionTokens = new WeakMap<CanonicalRequest, string>();
  readonly #autoDecisions = new Map<string, GithubAutoDecision>();

  constructor(fallbackBaseUrl: string, fetchImpl?: typeof fetch) {
    super(
      withBearerAuthentication({
        provider_id: GITHUB_PROVIDER_ID,
        base_url: fallbackBaseUrl,
        endpoint_paths_by_wire_family: {
          chat: GITHUB_ENDPOINT_PATH,
          responses: GITHUB_RESPONSES_ENDPOINT_PATH,
        },
        prePayload: (payload) => {
          clampGithubReasoningEffort(payload);
        },
        ...(fetchImpl ? { fetchImpl } : {}),
      }),
    );
    this.#fallbackBaseUrl = fallbackBaseUrl;
    this.#fetch = fetchImpl;
  }

  override async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    const tier = GITHUB_AUTO_MODEL_TIERS.get(candidate.model_id.toLowerCase());
    if (tier === undefined) {
      yield* super.dispatch(request, candidate, context);
      return;
    }

    const secret = context.credential.secret;
    if (secret === undefined || secret.length === 0) {
      throw new GatewayError("authentication_failed", 401, "GitHub Copilot credential is missing (request {requestId}). Wrong key, right door — check the credential 🔑");
    }
    const credential = new TextDecoder().decode(secret);
    const autoInput = autoPrompt(request);
    const sessionId = resolveInboundSessionId(context, request);
    const cacheKey = sessionId === undefined || sessionId.startsWith("aff_")
      ? undefined
      : this.#autoDecisionCacheKey(credential, sessionId, tier);
    let autoDecision = cacheKey === undefined
      ? undefined
      : this.#getCachedAutoDecision(cacheKey, autoInput.hasImage);
    if (autoDecision === undefined) {
      if (autoInput.prompt.length === 0) {
        throw new GatewayError("invalid_request", 400, "Copilot Auto requires a text prompt (request {requestId}). Check the shape of what you sent — then resend 🪞");
      }
      autoDecision = await this.#selectAutoModel(
        autoInput.prompt,
        tier,
        autoInput.hasImage,
        request,
        candidate,
        context,
      );
      if (cacheKey !== undefined) this.#cacheAutoDecision(cacheKey, autoDecision);
    }
    const selectedModelId = autoDecision.modelId;
    let route = autoDecision.route ?? await githubModelRoute(selectedModelId, credential);
    if (route === undefined) {
      // dynamic-import: discovery module is only loaded when the first
      // request routes to a model id not in the bundled roster; off the hot
      // path for most deployments.
      const { discoverGithubModels } = await import("./github-discovery");
      const outboundFetch = context.outbound_fetch;
      const fetcher = outboundFetch === undefined
        ? this.#fetch ?? globalThis.fetch
        : Object.assign(
            (input: RequestInfo | URL, init?: RequestInit) => outboundFetch(input, init),
            { preconnect: globalThis.fetch.preconnect.bind(globalThis.fetch) },
          );
      await discoverGithubModels({
        credential,
        fetcher,
        signal: context.abort_signal,
      });
      if (context.abort_signal.aborted) throw context.abort_signal.reason;
      route = await githubModelRoute(selectedModelId, credential);
    }
    if (route === undefined) {
      throw new GatewayError(
        "upstream_unprocessable",
        502,
        "Copilot Auto selected a model without a discovered inference endpoint (request {requestId}). The upstream came back empty-handed — retry 🌙",
        { selected_model: selectedModelId },
        "upstream",
      );
    }

    const routedRequest = applyParamQuirks(
      { ...request, model: selectedModelId },
      candidate.provider_id,
    );
    this.#autoSessionTokens.set(routedRequest, autoDecision.sessionToken);
    yield* super.dispatch(
      routedRequest,
      {
        ...candidate,
        model_id: selectedModelId,
        wire_family: route.wireFamily,
        endpoint_path: route.endpointPath,
      },
      context,
    );
  }

  async #selectAutoModel(
    prompt: string,
    tier: "efficiency" | "balance" | "intelligence",
    hasImage: boolean,
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): Promise<GithubAutoDecision> {
    const headers = await this.prepareHeaders(context, request, candidate);
    const credential = context.credential.secret === undefined
      ? undefined
      : parseGithubCredential(new TextDecoder().decode(context.credential.secret));
    if (credential === undefined) {
      throw new GatewayError("authentication_failed", 401, "GitHub Copilot credential is missing (request {requestId}). Wrong key, right door — check the credential 🔑");
    }
    const payload: Record<string, unknown> = { prompt, tier };
    if (hasImage) payload.has_image = true;
    const outboundFetch = context.outbound_fetch ?? this.#fetch ?? globalThis.fetch;
    const upstream = await postUpstreamJson(
      `https://${credential.apiHost}/auto`,
      headers,
      payload,
      context,
      outboundFetch,
    );
    let responsePayload: unknown;
    try {
      if (!upstream.res.ok) {
        await mapUpstreamHttpError(upstream.res, GITHUB_PROVIDER_ID);
      }
      responsePayload = await upstream.res.json();
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      if (context.abort_signal.aborted || upstream.signal.aborted) throw error;
      throw new GatewayError(
        "upstream_unprocessable",
        502,
        "Copilot Auto returned an invalid routing response (request {requestId}). The upstream came back empty-handed — retry 🌙",
        {},
        "upstream",
      );
    } finally {
      upstream.release();
    }
    if (
      typeof responsePayload !== "object" ||
      responsePayload === null ||
      !("selected_model" in responsePayload) ||
      typeof responsePayload.selected_model !== "object" ||
      responsePayload.selected_model === null ||
      !("id" in responsePayload.selected_model) ||
      typeof responsePayload.selected_model.id !== "string" ||
      responsePayload.selected_model.id.trim().length === 0 ||
      !("session_token" in responsePayload) ||
      typeof responsePayload.session_token !== "string" ||
      responsePayload.session_token.trim().length === 0
    ) {
      throw new GatewayError(
        "upstream_unprocessable",
        502,
        "Copilot Auto did not return a selected model (request {requestId}). The upstream came back empty-handed — retry 🌙",
        {},
        "upstream",
      );
    }
    const expiresAt =
      "expires_at" in responsePayload &&
      typeof responsePayload.expires_at === "number" &&
      Number.isFinite(responsePayload.expires_at)
        ? responsePayload.expires_at
        : 0;
    const route = routeFromAutoModel(responsePayload.selected_model);
    return {
      modelId: responsePayload.selected_model.id.trim(),
      sessionToken: responsePayload.session_token.trim(),
      expiresAt,
      hasImage,
      ...(route === undefined ? {} : { route }),
    };
  }

  #autoDecisionCacheKey(
    credentialValue: string,
    sessionId: string,
    tier: "efficiency" | "balance" | "intelligence",
  ): string {
    const credential = parseGithubCredential(credentialValue);
    const account = createHash("sha256")
      .update(`${credential.apiHost}:${credential.access}`)
      .digest("hex");
    return `${account}:${tier}:${sessionId}`;
  }

  #getCachedAutoDecision(
    cacheKey: string,
    hasImage: boolean,
  ): GithubAutoDecision | undefined {
    const decision = this.#autoDecisions.get(cacheKey);
    if (decision === undefined) return undefined;
    if (
      decision.expiresAt * 1_000 - Date.now() < GITHUB_AUTO_SESSION_EXPIRY_SKEW_MS ||
      (hasImage && !decision.hasImage)
    ) {
      this.#autoDecisions.delete(cacheKey);
      return undefined;
    }
    this.#autoDecisions.delete(cacheKey);
    this.#autoDecisions.set(cacheKey, decision);
    return decision;
  }

  #cacheAutoDecision(cacheKey: string, decision: GithubAutoDecision): void {
    if (
      decision.expiresAt * 1_000 - Date.now() < GITHUB_AUTO_SESSION_EXPIRY_SKEW_MS
    ) return;
    this.#autoDecisions.delete(cacheKey);
    if (this.#autoDecisions.size >= GITHUB_AUTO_SESSION_CACHE_MAX_ENTRIES) {
      const oldestKey = this.#autoDecisions.keys().next().value;
      if (oldestKey !== undefined) this.#autoDecisions.delete(oldestKey);
    }
    this.#autoDecisions.set(cacheKey, decision);
  }

  /** The account's host, or the provider default when the credential is unreadable. */
  #baseUrl(context: ProviderDispatchContext): string {
    const secret = context.credential.secret;
    if (secret === undefined || secret.length === 0) return this.#fallbackBaseUrl;
    try {
      return `https://${parseGithubCredential(new TextDecoder().decode(secret)).apiHost}`;
    } catch {
      return this.#fallbackBaseUrl;
    }
  }

  protected override async prepareHeaders(
    context: ProviderDispatchContext,
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
  ): Promise<Record<string, string>> {
    const headers = await super.prepareHeaders(context, request, candidate);
    // The Copilot API rejects a request that does not identify a Copilot
    // client, so these are a protocol requirement. `applyRouteUserAgent` has
    // already run inside the shared pipeline, so the identity is stamped after
    // it and wins — the route-level User-Agent is for generic OpenAI-compatible
    // hosts and would be rejected here.
    Object.assign(headers, GITHUB_REQUEST_HEADERS);
    const autoSessionToken = this.#autoSessionTokens.get(request);
    if (autoSessionToken !== undefined) {
      headers["Copilot-Session-Token"] = autoSessionToken;
    }
    const requestId = context.request_id ?? randomUUID();
    Object.assign(headers, {
      "editor-device-id": await getOrCreateInstallId("github"),
      "openai-intent": "conversation-agent",
      "x-agent-task-id": requestId,
      "x-interaction-id": requestId,
      "x-initiator": isAgentInitiated(request) ? "agent" : "user",
      "x-interaction-type": "conversation-agent",
      "x-request-id": requestId,
      "x-vscode-user-agent-library-version": "vscode-chat/0.72.0",
    });
    // The copy Claude family is served on the native Anthropic Messages wire,
    // which gates feature betas behind `anthropic-beta` (mirroring the
    // Copilot extension's `getAnthropicBetaHeader`). Adaptive thinking is the
    // baseline the model roster declares, so it is requested for every messages
    // route; the header is scoped to that wire and never sent elsewhere.
    if (candidate?.wire_family === "messages") {
      headers["anthropic-beta"] = "interleaved-thinking-2025-05-14";
    }
    if (allParts(request).some(containsImage)) {
      headers["copilot-vision-request"] = "true";
    } else {
      delete headers["copilot-vision-request"];
    }
    const secret = context.credential.secret;
    if (secret === undefined || secret.length === 0) return headers;
    try {
      const { access } = parseGithubCredential(new TextDecoder().decode(secret));
      headers.authorization = `Bearer ${access}`;
    } catch {
      // Left as the factory sent it: the request fails closed at the upstream
      // auth boundary, and the parse error belongs to the credential boundary.
    }
    return headers;
  }

  protected override async executeTransport(
    headers: Record<string, string>,
    payload: unknown,
    context: ProviderDispatchContext,
    _request?: CanonicalRequest,
    candidate?: ProviderDispatchTarget,
  ): Promise<Response> {
    // The host comes from the credential, which the shared config cannot see,
    // so the request is issued here against the resolved base URL instead of
    // the registered one. Everything else — the payload, the headers, the
    // deadline lifecycle — is what the shared pipeline produced.
    const endpointPath = candidate?.endpoint_path && candidate.endpoint_path.length > 0
      ? candidate.endpoint_path
      : GITHUB_ENDPOINT_PATH;
    const url = `${this.#baseUrl(context).replace(/\/+$/, "")}${endpointPath}`;
    const outboundFetch = context.outbound_fetch ?? this.#fetch ?? globalThis.fetch;
    const upstream = await postUpstreamJson(url, headers, payload as Record<string, unknown>, context, outboundFetch);
    upstream.release();
    return upstream.res;
  }
}

/** GitHub Copilot provider adapter. */
export const githubAdapter: ProviderAdapter = new GithubAdapter(
  providerBaseUrl(GITHUB_PROVIDER_ID),
);
