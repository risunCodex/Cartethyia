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
import {
  MIN_RETRY_BUDGET_MS,
  sleep as defaultSleep,
} from "../../../transport/failure-policy";
import { parseUpstreamBackoff } from "../../../protocol/upstream-parsing";

/**
 * Sleep used by the 429 capacity-wait loop, overridable in tests.
 *
 * A real capacity wait is tens of seconds by design, so a test that exercises
 * the loop would otherwise spend that long on the clock or blow its timeout.
 * Production always uses the shared `failure-policy` sleep; only a test swaps
 * it.
 */
let rateLimitSleep = defaultSleep;
export function _setCodexRateLimitSleepForTesting(
  impl: typeof defaultSleep | null,
): void {
  rateLimitSleep = impl ?? defaultSleep;
}
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return rateLimitSleep(ms, signal);
}
import { assertWireFamily } from "../../provider-contracts";
import type { ImageGenerationOutcome, ProviderDispatchTarget, ProviderAdapter, ProviderDispatchContext, ResolvedCredential, WebSearchOutcome, WebSearchResult } from "../../provider-contracts";
import type { FetchLike } from "../../quota/quota-contracts";
import { boundedUpstreamArray, boundedUpstreamNumber, sanitizeUpstreamLabel } from "../../provider-sanitize";
import {
  createCodexIdentity,
  getCodexAccountId,
  getCodexInstallId,
  getCodexResidency,
} from "./codex-identity";
import { mapCodexErrorResponse } from "./codex-errors";
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
import { defineModel } from "../../provider-model-definition";
import type { ModelDefinition } from "../../provider-model-definition";

/**
 * Codex static model catalog.
 *
 * Kept separate from the Codex adapter so the adapter's protocol graph
 * (`protocol/request/codex`, `protocol/response/codex`, identity headers) is
 * not evaluated merely to materialize the startup model catalog.
 */

function codexResponsesModel(
  modelId: string,
  contextLimit: number,
  outputLimit: number,
  image = false,
): ModelDefinition {
  return defineModel({
    id: modelId,
    wireFamily: "responses",
    endpoint: "/backend-api/codex/responses",
    ctx: contextLimit,
    out: outputLimit,
    vision: true,
    reasoning: !image,
    ...(image
      ? { serviceKind: "imageGeneration" as const, output: ["image"] as const, toolCall: false }
      : { toolCall: true }),
  });
}

export const CODEX_MODELS: readonly ModelDefinition[] = [
  // The 6-generation is served in a 272k *default* window that extends to
  // 922k, not a hard 272k cap. Measured against the live registry
  // (`/backend-api/codex/models`): `gpt-6-astra` reports `context_window`
  // 272000 and `max_context_window` 872000, and OpenAI documents 1.05M total
  // context for the generation — 922k input plus the 128k output ceiling — so
  // 922k is the input capacity and the registry's 872k is the stale figure.
  // Recording 272k here published a window less than a third of what the model
  // accepts and made the routing alias rows understate it too.
  //
  // The 5.6 generation keeps the full 1M it was given when OpenAI raised it;
  // the same registry still reports the pre-raise 272k for those ids.
  codexResponsesModel("gpt-6-astra", 922_000, 128_000),
  codexResponsesModel("gpt-6-luna", 922_000, 128_000),
  codexResponsesModel("gpt-6-sol", 922_000, 128_000),
  // 6.1-sol rides the same 6-generation 922k input / 128k output window as
  // gpt-6-sol (1.05M total). Daybreak was retired from the live registry.
  codexResponsesModel("gpt-6.1-sol", 922_000, 128_000),
  codexResponsesModel("gpt-5.6-sol", 1_000_000, 128_000),
  codexResponsesModel("gpt-5.6-terra", 1_000_000, 128_000),
  codexResponsesModel("gpt-5.6-luna", 1_000_000, 128_000),
  codexResponsesModel("gpt-5.5", 272_000, 128_000),
  // Dedicated image tools plus the `-image` variants of chat models, all
  // served on the same Responses endpoint.
  codexResponsesModel("gpt-image-2.5", 400_000, 128_000, true),
  codexResponsesModel("gpt-image-2.5-flare", 400_000, 128_000, true),
  codexResponsesModel("gpt-image-2.5-sunburst", 400_000, 128_000, true),
  codexResponsesModel("gpt-image-2", 400_000, 128_000, true),
  codexResponsesModel("gpt-image-1.5", 400_000, 128_000, true),
  codexResponsesModel("gpt-5.6-sol-image", 1_000_000, 128_000, true),
  codexResponsesModel("gpt-5.6-terra-image", 1_000_000, 128_000, true),
  codexResponsesModel("gpt-5.6-luna-image", 1_000_000, 128_000, true),
  codexResponsesModel("gpt-5.5-image", 272_000, 128_000, true),
];
const CODEX_SEARCH_DEFAULT_MODEL = "gpt-5.6-luna";

function normalizeCodexSearchCitations(
  citations: readonly unknown[],
  answerText: string,
): readonly WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  const snippet = answerText.trim().slice(0, 400);
  for (const raw of citations) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const nested = record.url_citation;
    const source =
      nested && typeof nested === "object" && !Array.isArray(nested)
        ? (nested as Record<string, unknown>)
        : record;
    const url = typeof source.url === "string" ? source.url : "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    results.push({
      title: typeof source.title === "string" ? source.title : "",
      url,
      snippet,
      published_at: null,
      score: null,
    });
  }
  return results;
}



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

const DEFAULT_CHATGPT_BASE_URL = "https://chatgpt.com";

/**
 * Total wall-clock a Codex dispatch may spend *waiting* on 429s.
 *
 * A transient quota/overload response is latency, not a terminal error: the
 * upstream names how long the bucket is closed and the request can simply
 * wait it out instead of surfacing `quota_exceeded` to the client. The budget
 * is what keeps that from becoming an unbounded stall — a server that keeps
 * restating a delay (or states one longer than the request has left) must not
 * hold the attempt open past its own deadline.
 *
 * 5 minutes matches the donor Codex 429 window this closes
 * (`openai-codex-responses.ts:310-311`, research item Codex #2) and is far
 * below the default request deadline, so the deadline clamp below — not this
 * cap — is the binding limit in practice.
 */
const CODEX_429_RETRY_BUDGET_MS = 5 * 60 * 1000;

/** Upper bound on one 429 wait before the deadline clamp. */
const CODEX_429_MAX_WAIT_MS = 60_000;

/** Zero-delay 429 guard. Grows from 50ms, doubling per wait. */
const CODEX_429_MIN_WAIT_MS = 50;

/** The `x-codex-*` window headers, in seconds or epoch seconds. */
function codexWindowResetMs(res: Response): number | undefined {
  for (const header of ["x-codex-primary-reset-at", "x-codex-secondary-reset-at"]) {
    const raw = res.headers.get(header);
    const parsed = raw === null || raw.trim().length === 0 ? Number.NaN : Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) continue;
    const targetMs = parsed >= 1_000_000_000 ? parsed * 1000 : Date.now() + parsed * 1000;
    const remaining = targetMs - Date.now();
    if (remaining > 0) return remaining;
  }
  return undefined;
}

/**
 * The delay the Codex upstream asked us to wait before retrying a 429, in ms.
 *
 * Standard backoff headers first, then the Codex window headers. `null` when
 * the upstream named no delay at all, which is *not* the same as "retry now" —
 * see `codex429WaitMs`.
 */
function codex429ServerDelayMs(res: Response): number | null {
  const headerDelay = parseUpstreamBackoff(res.headers);
  if (headerDelay !== null) return headerDelay;
  return codexWindowResetMs(res) ?? null;
}

/**
 * How long to actually wait before re-posting a 429, or `null` to stop.
 *
 * Pure — `now` is passed in rather than read, so the clamps are testable
 * without running the clock.
 *
 * Three cases:
 *
 * - **No server-stated delay** — a 429 that names no wait is retired as an
 *   error (current behavior), *except* that the first bare 429 gets one short
 *   backoff, because the rate-limit window itself is the evidence that a retry
 *   is meaningful. UNCONFIRMED: our captures do not show whether Codex emits
 *   `retry-after` on 429, so the header path is unverified against live traffic
 *   and the backoff is the conservative fallback.
 * - **The wait fits** — budget and deadline both leave room, so the stated
 *   delay is honored in full.
 * - **The wait does not fit** — clamped to what is left, or skipped entirely
 *   when less than `MIN_RETRY_BUDGET_MS` would remain, because a re-post the
 *   deadline would kill mid-flight has only turned a fast error into a slow
 *   one.
 */
export function codex429WaitMs(options: {
  readonly serverDelayMs: number | null;
  readonly waitedMs: number;
  readonly retry: number;
  readonly deadline: number;
  readonly now: number;
}): number | null {
  const { serverDelayMs, waitedMs, retry, deadline, now } = options;
  const target =
    serverDelayMs ?? (retry === 0 ? CODEX_429_MIN_WAIT_MS * 2 ** retry : null);
  if (target === null) return null;
  const budgetLeft = CODEX_429_RETRY_BUDGET_MS - waitedMs;
  if (budgetLeft <= 0) return null;
  // Leave the pre-dispatch floor for the re-post itself: the retry has to pay
  // the whole pre-dispatch phase again before the upstream is even called.
  const deadlineLeft = deadline - now - MIN_RETRY_BUDGET_MS;
  if (deadlineLeft <= 0) return null;
  const wait = Math.min(
    target,
    CODEX_429_MAX_WAIT_MS,
    Math.max(budgetLeft, 0),
    Math.max(deadlineLeft, 0),
  );
  return wait > 0 ? wait : null;
}

function authHeadersForCodex(
  credential: ResolvedCredential,
): Record<string, string> {
  if (!credential.secret || credential.secret.length === 0) {
    throw new GatewayError(
      "invalid_request",
      400,
      "codex: OAuth credential is missing a bearer token (request {requestId}). Wrong key, right door — check the credential 🔑",
    );
  }
  const token = new TextDecoder().decode(credential.secret);
  return { authorization: `Bearer ${token}` };
}

/**
 * Paths of the Codex model registry, in the order they are tried.
 *
 * The donor tries `/codex/models` first and `/models` second
 * (`packages/catalog/src/discovery/codex.ts:9`), both relative to the
 * `https://chatgpt.com/backend-api` root (`packages/catalog/src/wire/codex.ts:5`)
 * — so the first candidate is the same URL this file always used.
 *
 * The fallback used to be omitted on the ground that it exists upstream only
 * for relay base URLs this adapter does not support. It is restored because
 * fetching models failed outright with no listing endpoint reported: a single
 * candidate means one upstream shape change removes discovery entirely, while
 * trying both costs one extra request only when the first misses.
 */
const CODEX_MODELS_PATHS = ["/backend-api/codex/models", "/backend-api/models"] as const;
const CODEX_MODELS_PATH = CODEX_MODELS_PATHS[0];

/**
 * Shapes a client version may take for the `client_version` query parameter.
 *
 * The backend version-gates model availability on this value
 * (`packages/catalog/src/wire/codex.ts:28-32`), and the donor refuses to send
 * anything that is not `^\d+\.\d+\.\d+$`
 * (`packages/catalog/src/discovery/codex.ts:216-225`). Our pin is a discovered
 * npm version, so a malformed discovery result must not reach the query string:
 * a rejected URL would silently falsify the whole roster.
 */
const CODEX_CLIENT_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * Builds the Codex model-registry URL, version-gated by our pinned client
 * version.
 *
 * The backend gates model availability against `client_version` on `/models`
 * independently of a model's own `minimal_client_version`
 * (`packages/catalog/src/wire/codex.ts:28-32`), so omitting the parameter asks
 * for a roster the backend did not gate — which is why a SKU can appear in
 * discovery and then fail at dispatch, or be hidden while the pin can serve it.
 *
 * Fails closed on an unusable version by returning the un-gated URL rather than
 * throwing: version gating is an accuracy improvement, and a discovery call
 * that cannot be built must still be attempted. Matches the donor, which only
 * sets the parameter when it has a valid version
 * (`packages/catalog/src/discovery/codex.ts:195-201`).
 */
export function buildCodexModelsUrl(
  baseUrl: string,
  path: string = CODEX_MODELS_PATH,
  clientVersion = getCodexVersion(),
): string {
  const root = baseUrl.replace(/\/+$/, "");
  const url = `${root}${path}`;
  const version = clientVersion.trim();
  if (!CODEX_CLIENT_VERSION_PATTERN.test(version)) return url;
  return `${url}?client_version=${encodeURIComponent(version)}`;
}

/**
 * Limits assumed for a discovered SKU the registry did not state.
 *
 * The registry omits `context_window` for some SKUs, which is why the donor
 * carries its own fallback (`packages/catalog/src/discovery/codex.ts:10-11`,
 * `17`). These mirror it and the 128k output ceiling `CODEX_MODELS` uses, so a
 * discovered row is sized the way a static row would be rather than inheriting
 * `defineModel`'s unrelated 500k/128k defaults.
 */
const DEFAULT_CODEX_DISCOVERY_CONTEXT_LIMIT = 272_000;
const DEFAULT_CODEX_DISCOVERY_OUTPUT_LIMIT = 128_000;

/**
 * Reads the Codex model registry as `ModelDefinition` rows.
 *
 * `{ models: [...] }` is the shape the donor parses
 * (`packages/catalog/src/discovery/codex.ts:76-79`, `237`), and `slug` is the
 * id (`316`). Rows are registered on the Codex Responses endpoint, matching
 * `CODEX_MODELS`, so a discovered SKU dispatches the same way as a static one.
 *
 * Returns `null` on any transport, status, or parse failure. Discovery is an
 * enrichment over the static catalog: failing it must fall back to
 * `CODEX_MODELS`, never to an empty model list.
 */
export async function discoverCodexModels(input: {
  readonly credential: string;
  readonly baseUrl?: string;
  readonly signal?: AbortSignal;
  readonly fetcher?: FetchLike;
}): Promise<readonly ModelDefinition[] | null> {
  const token = input.credential.trim();
  if (token.length === 0) return null;
  const accountId = getCodexAccountId(token);
  const residency = getCodexResidency({ accessToken: token });
  const version = getCodexVersion();
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${token}`,
    "user-agent": buildCodexUserAgent(version),
    // Identity headers as the donor builds them
    // (`packages/catalog/src/discovery/codex.ts:203-214`): `version` carries the
    // same value as the query parameter, and `originator` is our own CLI
    // identity rather than the donor's `omp`, for the same reason dispatch does.
    originator: "codex_cli_rs",
    version,
    "OpenAI-Beta": "responses=experimental",
    ...(accountId === undefined || accountId.length === 0 ? {} : { "chatgpt-account-id": accountId }),
    ...(residency === undefined || residency.length === 0
      ? {}
      : { "x-openai-internal-codex-residency": residency }),
  };
  const fetcher = input.fetcher ?? globalThis.fetch;
  const root = input.baseUrl ?? DEFAULT_CHATGPT_BASE_URL;
  let entries: readonly unknown[] | undefined;
  try {
    // Each candidate is tried in order and the first usable roster wins. The
    // loop is what the donor does (`packages/catalog/src/discovery/codex.ts:138`);
    // a non-200 or an unparseable body just advances to the next path, and
    // exhausting them is the same "no roster" outcome as before.
    for (const path of CODEX_MODELS_PATHS) {
      let response: Response;
      try {
        response = await fetcher(buildCodexModelsUrl(root, path, version), {
          method: "GET",
          headers,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      } catch {
        continue;
      }
      if (!response.ok) continue;
      let payload: unknown;
      try {
        payload = (await response.json()) as unknown;
      } catch {
        continue;
      }
      const found = boundedUpstreamArray(isRecord(payload) ? payload["models"] : undefined);
      if (found === undefined) continue;
      entries = found;
      break;
    }
  } catch {
    return null;
  }
  if (entries === undefined) return null;
  const byId = new Map<string, ModelDefinition>();
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const id = sanitizeUpstreamLabel(entry["slug"] ?? entry["id"]);
    if (id === undefined) continue;
    const contextLimit = boundedUpstreamNumber(entry["context_window"], { min: 1, max: 1_000_000_000 });
    const outputLimit = boundedUpstreamNumber(entry["max_output_tokens"], { min: 1, max: 1_000_000_000 });
    byId.set(
      id,
      codexResponsesModel(
        id,
        contextLimit ?? DEFAULT_CODEX_DISCOVERY_CONTEXT_LIMIT,
        outputLimit ?? DEFAULT_CODEX_DISCOVERY_OUTPUT_LIMIT,
      ),
    );
  }
  return [...byId.values()].sort((a, b) => a.modelId.localeCompare(b.modelId));
}

/** Reads just enough of an untyped body to tell SSE from JSON, then replays it. */
async function sniffSseBody(body: ReadableStream<Uint8Array> | null): Promise<{
  readonly sse: boolean;
  readonly body: ReadableStream<Uint8Array> | null;
}> {
  if (body === null) return { sse: false, body };
  const reader = body.getReader();
  const first = await reader.read();
  if (first.done || first.value.byteLength === 0) return { sse: false, body: null };
  const head = new TextDecoder().decode(first.value.subarray(0, 32)).trimStart();
  const sse = head.startsWith("event:") || head.startsWith("data:") || head.startsWith(":");
  const replay = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first.value);
    },
    async pull(controller) {
      const next = await reader.read();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { sse, body: replay };
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
  // reuse. Bounded LRU + TTL: an unbounded map would leak
  // memory forever under a long-running process serving many distinct
  // Codex sessions.
  const sessionStates = new Map<
    string,
    { state: CodexSessionState; lastAccessMs: number }
  >();
  const MAX_SESSION_STATES = 2000;
  const SESSION_STATE_TTL_MS = 60 * 60 * 1000;

  function pruneExpiredSessionStates(): void {
    const cutoff = Date.now() - SESSION_STATE_TTL_MS;
    for (const [id, entry] of sessionStates) {
      if (entry.lastAccessMs < cutoff) sessionStates.delete(id);
    }
  }

  function getSessionState(id: string): CodexSessionState | undefined {
    const entry = sessionStates.get(id);
    if (entry === undefined) return undefined;
    if (entry.lastAccessMs < Date.now() - SESSION_STATE_TTL_MS) {
      sessionStates.delete(id);
      return undefined;
    }
    // Refresh recency: delete+set moves the entry to the end (Map preserves
    // insertion order), making eviction below a true least-recently-used sweep.
    sessionStates.delete(id);
    entry.lastAccessMs = Date.now();
    sessionStates.set(id, entry);
    return entry.state;
  }

  function setSessionState(id: string, state: CodexSessionState): void {
    pruneExpiredSessionStates();
    sessionStates.delete(id);
    sessionStates.set(id, { state, lastAccessMs: Date.now() });
    while (sessionStates.size > MAX_SESSION_STATES) {
      const oldest = sessionStates.keys().next();
      if (oldest.done) break;
      sessionStates.delete(oldest.value);
    }
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
        "https://chatgpt.com/backend-api/codex/responses/compact",
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
