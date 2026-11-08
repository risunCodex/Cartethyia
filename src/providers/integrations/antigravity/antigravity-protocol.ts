/**
 * Antigravity wire-level helpers:
 * - `getAntigravityVersion()`: monitor-owned version snapshot used by the
 *   `antigravity/hub` `User-Agent` header.
 * - `getAntigravityUserAgent()`: full `antigravity/hub/<version>` string.
 * - `ANTIGRAVITY_MODEL_WIRE_PROFILES` / `getAntigravityModelWireProfile()`:
 *   per-wire-id `maxOutputTokens` (and optional `labels.model_enum`) the
 *   backend enforces.
 * - `applySkipThoughtSignatureBypass()`: on Gemini 3+ turns, the first
 *   unsigned `functionCall` in a `model`-role content block gets the
 *   `skip_thought_signature_validator` sentinel.
 * - `loadAntigravityProject()`: best-effort `loadCodeAssist` lookup for
 *   the caller's Cloud Code project id, cached by access-token hash.
 *
 * The global client-version monitor refreshes the version. Request paths only
 * read the current snapshot and never fetch the update manifest.
 */
import { createHash } from "node:crypto";
import { providerBaseUrl } from "../../provider-metadata";
import { defineModel, type ModelDefinition } from "../../provider-model-definition";
import { isRecord } from "../../../protocol/codecs";
import { modelsDevCatalog } from "../../discovery/models-dev-catalog";
import type { CanonicalRequest, ReasoningIntent } from "../../../protocol/canonical-model";
import type { FetchLike } from "../../authentication/oauth-client";
import { getAntigravityVersion } from "../../operations/client-versions";
export { getAntigravityVersion };


/** Desktop-client fingerprint fields stamped into the Antigravity User-Agent. */
const ANTIGRAVITY_OS_TYPE = "darwin";
const ANTIGRAVITY_ARCH = "arm64";
const ANTIGRAVITY_CL = "963137146";

/**
 * Env overrides for the three fingerprint fields, read per call so a test (or an
 * operator editing `.env` and reloading) sees the current value rather than a
 * process-start snapshot.
 *
 * These are the provider-local knobs the reference client exposes
 * (`CARTETHYIA_ANTIGRAVITY_UA_OS_TYPE` / `_ARCH` / `_CL`); they exist so a
 * Linux/x64 deployment stops claiming `darwin`/`arm64` on the wire. The
 * defaults stay pinned to the captured desktop client because the backend
 * gates on the version, not on these fields.
 */
const UA_OS_TYPE_ENV = "CARTETHYIA_ANTIGRAVITY_UA_OS_TYPE";
const UA_ARCH_ENV = "CARTETHYIA_ANTIGRAVITY_UA_ARCH";
const UA_CL_ENV = "CARTETHYIA_ANTIGRAVITY_UA_CL";

/**
 * `os_type`/`arch`/`cl` are opaque to the backend but they are still header
 * bytes on a shared transport, so an override is sanitized to the characters
 * the captured client ever emits. A value containing anything else (a quoted
 * or delimited injection) is dropped in favor of the default rather than
 * forwarded, which keeps one env var from corrupting the whole UA string.
 */
const UA_FIELD_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function uaField(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) return fallback;
  return UA_FIELD_PATTERN.test(raw) ? raw : fallback;
}

/**
 * Antigravity `User-Agent` header value; rebuilt when the discovered version
 * changes. Format captured from the real `antigravity/hub` desktop client:
 * `antigravity/hub/2.8.0 (aidev_client; os_type=darwin; arch=arm64; cl=963137146)`.
 *
 * The backend does not validate `cl` (verified live: stale, zero, and absent
 * `cl` all pass model gating on `daily-cloudcode-pa`; only the version
 * gates). The `cl`/`os_type`/`arch` fields are desktop-client fingerprints,
 * not operator policy — they default to the captured desktop values but are
 * env-overridable so a deployment need not claim `darwin`/`arm64`.
 */
export function getAntigravityUserAgent(): string {
  const osType = uaField(UA_OS_TYPE_ENV, ANTIGRAVITY_OS_TYPE);
  const arch = uaField(UA_ARCH_ENV, ANTIGRAVITY_ARCH);
  const cl = uaField(UA_CL_ENV, ANTIGRAVITY_CL);
  return `antigravity/hub/${getAntigravityVersion()} (aidev_client; os_type=${osType}; arch=${arch}; cl=${cl})`;
}

// Per-wire-id request constants

interface AntigravityModelWireProfile {
  readonly modelEnum?: string;
  readonly maxOutputTokens: number;
  /**
   * Telemetry label for the `used_claude` / `used_claude_conservative` request
   * labels. The reference client honors a per-model compat value and falls back
   * to the model-class test; a model whose billing identity differs from its
   * id substring (a Claude-route Gemini id, or vice versa) declares it here
   * instead of relying on `id.includes("claude")`.
   */
  readonly usageLabel?: string;
}

/**
 * `maxOutputTokens` the backend enforces per wire id (captured from the real
 * `antigravity/hub` client and verified live against `fetchAvailableModels`
 * on 2026-11-03). Claude on `daily-cloudcode-pa` rejects
 * `maxOutputTokens > 64000` with a `400 Request contains an invalid argument`
 * regardless of the thinking budget; Gemini SKUs accept their discovered
 * output ceiling. Keyed by the routed upstream wire id (post effort-routing),
 * not the collapsed logical id. Missing entry = pass the request's own
 * `maxOutputTokens` through unmodified.
 */
const ANTIGRAVITY_MODEL_WIRE_PROFILES: Readonly<
  Record<string, AntigravityModelWireProfile>
> = Object.freeze({
  // Anthropic on Antigravity caps at 64000 output tokens (verified live).
  "claude-opus-4-6-thinking": {
    modelEnum: "MODEL_PLACEHOLDER_M26",
    maxOutputTokens: 64000,
  },
  "claude-sonnet-4-6": {
    modelEnum: "MODEL_PLACEHOLDER_M35",
    maxOutputTokens: 64000,
  },
  // Gemini SKUs, as the live roster publishes them (2026-11-03).
  "gemini-2.5-flash": {
    modelEnum: "MODEL_GOOGLE_GEMINI_2_5_FLASH",
    maxOutputTokens: 65535,
  },
  "gemini-2.5-flash-thinking": {
    modelEnum: "MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING",
    maxOutputTokens: 65535,
  },
  "gemini-2.5-flash-lite": {
    modelEnum: "MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE",
    maxOutputTokens: 65535,
  },
  "gemini-2.5-pro": {
    modelEnum: "MODEL_GOOGLE_GEMINI_2_5_PRO",
    maxOutputTokens: 65535,
  },
  "gemini-3-flash": {
    modelEnum: "MODEL_PLACEHOLDER_M18",
    maxOutputTokens: 65536,
  },
  "gemini-3.1-flash-lite": {
    modelEnum: "MODEL_PLACEHOLDER_M50",
    maxOutputTokens: 65535,
  },
  "gemini-3.1-flash-image": {
    modelEnum: "MODEL_PLACEHOLDER_M21",
    maxOutputTokens: 65536,
  },
  "gemini-3.5-flash-lite": {
    modelEnum: "MODEL_PLACEHOLDER_M198",
    maxOutputTokens: 65535,
  },
  // Gemini 3.8 Flash effort tiers (real deployment names).
  "gemini-3.8-flash-low": {
    modelEnum: "MODEL_PLACEHOLDER_M320",
    maxOutputTokens: 65536,
  },
  "gemini-3.8-flash-medium": {
    modelEnum: "MODEL_PLACEHOLDER_M319",
    maxOutputTokens: 65536,
  },
  "gemini-3.8-flash-high": {
    modelEnum: "MODEL_PLACEHOLDER_M318",
    maxOutputTokens: 65536,
  },
  "gemini-3.8-flash-tiered": {
    modelEnum: "MODEL_PLACEHOLDER_M322",
    maxOutputTokens: 65536,
  },
  // GPT-OSS via Antigravity (verified live).
  "gpt-oss-120b-medium": {
    modelEnum: "MODEL_OPENAI_GPT_OSS_120B_MEDIUM",
    maxOutputTokens: 32768,
  },
  // Tab (laptop-class) preview SKU.
  "tab_flash_lite_preview": {
    modelEnum: "MODEL_PLACEHOLDER_M19",
    maxOutputTokens: 4096,
  },
});

export function getAntigravityModelWireProfile(
  wireModelId: string,
): AntigravityModelWireProfile | undefined {
  return ANTIGRAVITY_MODEL_WIRE_PROFILES[wireModelId];
}

/**
 * Collapses logical/display model ids to the upstream deployment ("wire")
 * ids actually accepted by `daily-cloudcode-pa`. The console keeps the
 * friendly logical id on screen; every upstream request resolves through
 * this mapping so deployment names stay out of the catalog UI. Ids without
 * a mapping are already valid wire ids and pass through unchanged.
 */
export function antigravityWireModelId(modelId: string): string {
  if (modelId === "claude-opus-4-6") return "claude-opus-4-6-thinking";
  if (modelId === "gemini-3.1-pro" || modelId === "gemini-3.1-pro-high") {
    return "gemini-pro-agent";
  }
  if (modelId === "gemini-3.6-flash") return "gemini-3.6-flash-low";
  if (modelId === "gemini-3.7-flash") return "gemini-3.7-flash-low";
  if (modelId === "gemini-3.8-flash") return "gemini-3.8-flash-low";
  if (modelId === "gpt-oss-120b") return "gpt-oss-120b-medium";
  return modelId;
}

// Claude-route `anthropic-beta` passthrough (`interleaved-thinking`).

/**
 * The one beta the reference client adds on Claude reasoning routes
 * (`google-gemini-cli.ts:601-603`). Named to match the vocabulary in
 * `claude-betas.ts` (`ANTHROPIC_BETA_CAPABILITIES`) rather than re-spelled
 * here; that module is the single owner of beta names, so this is a literal
 * of an entry it already declares.
 *
 * UNCONFIRMED: that `daily-cloudcode-pa` gates Claude thinking on this header.
 * The reference sends it, and a thinking request that omits it is untested
 * against the live backend. It is only sent when the turn actually carries a
 * thinking intent, so a non-thinking Claude route is byte-identical to before.
 */
export const ANTIGRAVITY_CLAUDE_THINKING_BETA = "interleaved-thinking-2025-05-14";

/**
 * Whether a Claude-via-Antigravity turn should advertise interleaved thinking.
 *
 * Thinking is "requested" in either of the two ways the canonical request can
 * express it: an explicit enabled/adaptive `thinking_type`, or a thinking
 * budget. `disabled` is excluded — it is an affirmative request for no
 * thinking, not a thinking request.
 */
export function antigravityClaudeThinkingBeta(
  request: { readonly reasoning?: ReasoningIntent | undefined },
  isClaudeRoute: boolean,
): string | undefined {
  if (!isClaudeRoute) return undefined;
  const reasoning = request.reasoning;
  if (reasoning === undefined || reasoning === null) return undefined;
  if (reasoning.thinking_type === "disabled") return undefined;
  const wantsThinking =
    reasoning.thinking_type === "enabled" ||
    reasoning.thinking_type === "adaptive" ||
    reasoning.budget_tokens !== undefined;
  return wantsThinking ? ANTIGRAVITY_CLAUDE_THINKING_BETA : undefined;
}

// Tool schema normalization (`parametersJsonSchema` → `parameters`).

/**
 * Rewrites a tool schema that nests its real object schema under
 * `parametersJsonSchema` into the bare schema Gemini expects.
 *
 * The reference client rewrites this spelling before the request goes out
 * (`google-gemini-cli.ts:1196-1213`); without it the shared Gemini builder
 * strips the unknown key and ships `{"type":"object"}`, so every declared
 * property is dropped and the tool arrives unusable. Only a value under
 * `parametersJsonSchema` (or `parameters`) that is itself a record is
 * adopted — a stray non-object there must not replace a real schema.
 *
 * Returns the *same reference* when there is nothing to rewrite, so the
 * request-level helper can detect "no change" without a deep compare.
 */
export function normalizeAntigravityToolSchema(schema: unknown): unknown {
  if (!isRecord(schema)) return schema;
  for (const key of ["parametersJsonSchema", "parameters"]) {
    const nested = schema[key];
    if (isRecord(nested)) return nested;
  }
  return schema;
}

/**
 * Flattens JSON-Schema constructs the Antigravity upstream rejects.
 *
 * Verified live (2026-11-05): the Claude-route upstream validates tool
 * schemas as strict JSON Schema draft 2020-12 and refuses every `anyOf` /
 * `oneOf` / multi-type `type: [...]` declaration — even a degenerate
 * `anyOf` of two identical string schemas, and even at the root. The Gemini
 * builder's sanitizer keeps those constructs (Gemini itself accepts them), so
 * a tool that declares a union (e.g. OMP's `task` tool's `model` field)
 * ships an invalid schema and the upstream 400s the whole request with
 * `tools.N.custom.input_schema: JSON schema is invalid`.
 *
 * The rewrite replaces `anyOf`/`oneOf` with the single most permissive
 * alternative's type (string when a choice is a string, otherwise any
 * surviving type), and a multi-type `type: [...]` with its first entry —
 * the most permissive shape a strict single-type validator can express.
 * Recurses through `properties` and `items`.
 */
export function flattenAntigravitySchema(schema: unknown): unknown {
  if (!isRecord(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(schema)) {
    if (key === "anyOf" || key === "oneOf") {
      if (!Array.isArray(child)) continue;
      const chosen = child.map((entry) => flattenAntigravitySchema(entry)).find(isRecord);
      if (chosen === undefined) continue;
      if (typeof chosen["type"] === "string") out["type"] = chosen["type"];
      for (const [nestedKey, nestedValue] of Object.entries(chosen)) {
        if (nestedKey === "type") continue;
        out[nestedKey] = nestedValue;
      }
      continue;
    }
    if (key === "type" && Array.isArray(child)) {
      const first = child.find((entry): entry is string => typeof entry === "string");
      if (first !== undefined) out["type"] = first;
      continue;
    }
    if (key === "properties" && isRecord(child)) {
      out["properties"] = Object.fromEntries(
        Object.entries(child).map(([name, entry]) => [name, flattenAntigravitySchema(entry)]),
      );
      continue;
    }
    if (key === "items" && Array.isArray(child)) {
      out["items"] = child.map((entry) => flattenAntigravitySchema(entry));
      continue;
    }
    if (key === "items" && isRecord(child)) {
      out["items"] = flattenAntigravitySchema(child);
      continue;
    }
    out[key] = child;
  }
  return out;
}

/**
 * Applies both tool-schema normalizations (unwrap `parametersJsonSchema`,
 * flatten rejected union constructs) and reports whether anything changed.
 *
 * When flattening is a no-op, the *original* reference is returned so the
 * request-level helper can detect an unchanged request without a deep compare.
 */
export function normalizeAntigravityToolSchemaForWire(schema: unknown): {
  readonly schema: unknown;
  readonly changed: boolean;
} {
  const unwrapped = normalizeAntigravityToolSchema(schema);
  const flattened = flattenAntigravitySchema(unwrapped);
  const unwrapChanged = unwrapped !== schema;
  const flattenChanged =
    flattened !== unwrapped && JSON.stringify(flattened) !== JSON.stringify(unwrapped);
  return {
    schema: flattenChanged ? flattened : unwrapped,
    changed: unwrapChanged || flattenChanged,
  };
}

/**
 * Normalizes every declared tool's schema on a canonical request, returning a
 * shallow copy of the request when anything changed and the original object
 * otherwise.
 *
 * This has to run *before* `buildGeminiPayload`, not after: that builder
 * passes `jsonSchema` through `sanitizeGeminiSchema`, whose key allowlist has
 * no `parametersJsonSchema` entry, so the wrapper and the real schema inside it
 * are both dropped and the declaration ships as `{"type":"object"}`. By the
 * time the payload exists there is nothing left to recover.
 *
 * Only the `tools` array is copied; messages and controls are shared with the
 * original request by reference.
 */
export function normalizeAntigravityToolSchemas(request: CanonicalRequest): CanonicalRequest {
  const tools = request.tools;
  if (tools === undefined || tools.length === 0) return request;
  let changed = false;
  const normalized = tools.map((tool) => {
    const { schema, changed: schemaChanged } = normalizeAntigravityToolSchemaForWire(tool.jsonSchema);
    if (!schemaChanged) return tool;
    changed = true;
    return { ...tool, jsonSchema: schema };
  });
  return changed ? { ...request, tools: normalized } : request;
}

/**
 * Drops replayed reasoning blocks that carry no signature on a Claude route.
 *
 * The Claude-route upstream requires every `thinking` block in a replayed
 * assistant turn to carry a `signature`; an unsigned block is rejected with
 * `400 messages.N.content.0.thinking.signature: Field required`. Chat-surface
 * clients (e.g. OMP) replay reasoning as a bare `reasoning_content` string
 * that has no signature — there is nothing to forward, and sending it as an
 * unsigned `thought` part guarantees the 400.
 *
 * The reference client solves this with a `drop-unsigned-thinking` compat flag
 * on `google-antigravity` (donor `anthropic.kdl:743-748`): a thinking block
 * without a signature is simply not replayed. This mirrors that behavior —
 * reasoning with a real signature still replays; reasoning without one is
 * dropped so the upstream never sees an unsigned `thinking` part.
 */
export function dropAntigravityUnsignedReasoning(
  request: CanonicalRequest,
  isClaudeRoute: boolean,
): CanonicalRequest {
  if (!isClaudeRoute) return request;
  const messages = request.messages;
  let changed = false;
  const next = messages.map((message) => {
    if (message.role !== "assistant") return message;
    const content = message.content.filter((part) => {
      if (part.kind !== "reasoning") return true;
      // A present-but-empty signature is still unsigned: upstream rejects a
      // `thinking` part whose `signature` is missing *or* empty with
      // `400 messages.N.content.0.thinking.signature: Field required`. Only a
      // non-empty signature is a real one.
      if (typeof part.signature === "string" && part.signature.length > 0) return true;
      changed = true;
      return false;
    });
    return changed ? { ...message, content } : message;
  });
  return changed ? { ...request, messages: next } : request;
}

// Last-good-endpoint stickiness

/**
 * Endpoint that answered successfully most recently, per base URL.
 *
 * The reference client probes endpoints in a fixed order and remembers the one
 * that last worked (`google-gemini-cli.ts:556-571,:1076-1081`), so a dead
 * production host is not re-probed on every turn — only the first request after
 * a failover pays the extra round trip.
 *
 * Keyed by base URL (not by account) because reachability is a property of the
 * host the deployment talks to, and the value is only ever an endpoint this
 * process has already resolved from that base.
 */
const lastGoodEndpoints = new Map<string, string>();
const LAST_GOOD_ENDPOINT_MAX = 256;

/**
 * Records the endpoint that just served a successful turn. Call this with the
 * `endpoint` reported by empty-stream recovery (or the URL that produced a
 * non-empty stream) so the next turn can start there.
 */
export function rememberAntigravityEndpoint(baseUrl: string, endpoint: string): void {
  if (typeof endpoint !== "string" || endpoint.length === 0) return;
  lastGoodEndpoints.set(baseUrl, endpoint);
  while (lastGoodEndpoints.size > LAST_GOOD_ENDPOINT_MAX) {
    const oldest = lastGoodEndpoints.keys().next().value;
    if (oldest === undefined) break;
    lastGoodEndpoints.delete(oldest);
  }
}

/** Clears the sticky endpoint for one base, or for every base when omitted. */
export function resetAntigravityEndpointMemory(baseUrl?: string): void {
  if (baseUrl === undefined) lastGoodEndpoints.clear();
  else lastGoodEndpoints.delete(baseUrl);
}

/**
 * Orders `endpoints` so the last one known to have worked is tried first.
 *
 * Pure with respect to the caller's list: every entry is preserved exactly
 * once, only the order changes, and an endpoint no longer in the list (a base
 * URL whose sandbox twin disappeared) is ignored rather than injected. A
 * sticky entry equal to the first endpoint is a no-op, so the steady state is
 * the caller's own order.
 */
export function orderAntigravityEndpoints(
  baseUrl: string,
  endpoints: readonly string[],
): readonly string[] {
  if (endpoints.length <= 1) return endpoints;
  const sticky = lastGoodEndpoints.get(baseUrl);
  if (sticky === undefined) return endpoints;
  const index = endpoints.indexOf(sticky);
  if (index <= 0) return endpoints;
  return [sticky, ...endpoints.slice(0, index), ...endpoints.slice(index + 1)];
}

// Model discovery (`v1internal:fetchAvailableModels`) — live catalog.

const ANTIGRAVITY_DISCOVERY_PATH = "/v1internal:fetchAvailableModels";
const ANTIGRAVITY_DISCOVERY_SANDBOX_ENDPOINT =
  "https://daily-cloudcode-pa.sandbox.googleapis.com";
const ANTIGRAVITY_DEFAULT_CONTEXT_WINDOW = 200_000;
const ANTIGRAVITY_DEFAULT_MAX_OUTPUT_TOKENS = 64_000;
const ANTIGRAVITY_GENERATE_PATH = "/v1internal:generateContent";

/** Internal/dead wire ids excluded from the discovered catalog. */
const ANTIGRAVITY_DISCOVERY_DENYLIST: Readonly<Record<string, true>> = {
  chat_20706: true,
  chat_23310: true,
  "gemini-2.5-pro": true,
};

/**
 * Collapses effort-routed wire ids back to their logical catalog id so the
 * console shows one friendly name per effort family. `antigravityWireModelId`
 * is the inverse: it resolves the logical id to a live wire deployment at
 * dispatch time. Unmapped ids are already logical ids and pass through.
 */
export function collapseAntigravityVariant(modelId: string): string {
  if (modelId === "claude-opus-4-6-thinking") return "claude-opus-4-6";
  if (modelId === "gemini-pro-agent") return "gemini-3.1-pro";
  return modelId.replace(/(?:-(?:extra-low|low|medium|high|tiered|agent))$/, "");
}

interface AntigravityDiscoveryModel {
  readonly displayName?: unknown;
  readonly maxTokens?: unknown;
  readonly maxOutputTokens?: unknown;
  readonly supportsThinking?: unknown;
  readonly supportsImages?: unknown;
  readonly isInternal?: unknown;
}

function positiveAntigravityInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function normalizeAntigravityDiscoveryModels(
  value: unknown,
): readonly ModelDefinition[] | null {
  if (!isRecord(value) || !isRecord(value["models"])) return null;
  const byId = new Map<string, ModelDefinition>();
  for (const [wireId, raw] of Object.entries(value["models"])) {
    if (
      ANTIGRAVITY_DISCOVERY_DENYLIST[wireId] === true ||
      !isRecord(raw) ||
      raw["isInternal"] === true
    ) {
      continue;
    }
    const model = raw as AntigravityDiscoveryModel;
    const logicalId = collapseAntigravityVariant(wireId);
    const definition: ModelDefinition = {
      modelId: logicalId,
      wireFamily: "chat",
      endpointPath: ANTIGRAVITY_GENERATE_PATH,
      contextLimit: positiveAntigravityInt(
        model.maxTokens,
        ANTIGRAVITY_DEFAULT_CONTEXT_WINDOW,
      ),
      outputLimit: positiveAntigravityInt(
        model.maxOutputTokens,
        ANTIGRAVITY_DEFAULT_MAX_OUTPUT_TOKENS,
      ),
      modalities: { input: ["text", "image"], output: ["text"] },
      reasoning: model.supportsThinking === true,
      toolCall: true,
      cost: modelsDevCatalog.costFor("antigravity", logicalId),
    };
    const existing = byId.get(logicalId);
    if (
      existing === undefined ||
      (definition.contextLimit ?? 0) > (existing.contextLimit ?? 0)
    ) {
      byId.set(logicalId, definition);
    }
  }
  return [...byId.values()].sort((left, right) =>
    left.modelId.localeCompare(right.modelId),
  );
}

/**
 * Fetches and normalizes Antigravity's live model catalog. Returns `null`
 * when the catalog is unreachable so routing keeps serving the static
 * `ANTIGRAVITY_MODELS` fallback.
 */
export async function discoverAntigravityModels(
  accessToken: string,
  options: {
    readonly baseUrl?: string;
    readonly fetcher?: typeof fetch;
    readonly signal?: AbortSignal;
    readonly projectId?: string;
  } = {},
): Promise<readonly ModelDefinition[] | null> {
  const fetcher = options.fetcher ?? fetch;
  const primary = (options.baseUrl ?? providerBaseUrl("antigravity")).replace(
    /\/+$/,
    "",
  );
  for (const endpoint of [primary, ANTIGRAVITY_DISCOVERY_SANDBOX_ENDPOINT]) {
    try {
      const timeoutSignal = AbortSignal.timeout(3_000);
      const signal =
        options.signal === undefined
          ? timeoutSignal
          : AbortSignal.any([options.signal, timeoutSignal]);
      const response = await fetcher(`${endpoint}${ANTIGRAVITY_DISCOVERY_PATH}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          "user-agent": getAntigravityUserAgent(),
        },
        // The reference client always sends the resolved project
        // (`cloudCodeMainService.js`); the live backend accepts both, but the
        // project is required for billing-gated endpoints.
        body: JSON.stringify(options.projectId === undefined ? {} : { project: options.projectId }),
        signal,
      });
      if (!response.ok) continue;
      const models = normalizeAntigravityDiscoveryModels(
        (await response.json()) as unknown,
      );
      if (models === null) continue;
      // Keep the static websearch row on top of discovered rows: the live
      // catalog does not publish search SKUs, and `/v1/search` needs a
      // `service_kind: "websearch"` row to route.
      return [
        ...models,
        defineModel({
          id: "gemini-2.5-flash",
          providerId: "antigravity",
          serviceKind: "websearch",
          wireFamily: "chat",
          // Empty endpoint — see `ANTIGRAVITY_SEARCH_MODELS`.
          endpoint: "",
          ctx: 1_000_000,
          out: 65_535,
          vision: true,
          reasoning: true,
          toolCall: false,
        }),
      ];
    } catch {
      // Best-effort: a failed live catalog must never break static routing.
    }
  }
  return null;
}

// Skip-thought-signature bypass (Gemini 3+ first-unsigned-functionCall rule)

/**
 * Sentinel Google APIs accept in place of a real base64 thought signature.
 * Antigravity CloudCode requires it only on the *first* unsigned functionCall
 * inside a `model`-role turn; unsigned secondary calls in the same turn stay
 * bare. Signed-first parallel turns leave every secondary call untouched.
 */
const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

/** True for Gemini 3.x and above (the SKUs the bypass rule applies to). */
function isGemini3Plus(modelId: string): boolean {
  return /^gemini-(?:[3-9]|\d{2,})(?:[.-]|$)/.test(modelId);
}

/**
 * Post-processes a Gemini-shaped payload: for each `model`-role content
 * block, add `thoughtSignature = SKIP_THOUGHT_SIGNATURE` to the first
 * unsigned `functionCall`. Leaves signed calls and unsigned secondary calls
 * untouched. No-op for non-Gemini-3+ models.
 */
export function applySkipThoughtSignatureBypass(
  payload: Record<string, unknown>,
  modelId: string,
): void {
  if (!isGemini3Plus(modelId)) return;
  const contents = payload["contents"];
  if (!Array.isArray(contents)) return;
  for (const turn of contents) {
    if (!isRecord(turn)) continue;
    if (turn["role"] !== "model") continue;
    const parts = turn["parts"];
    if (!Array.isArray(parts)) continue;
    let isFirst = true;
    for (const part of parts) {
      if (!isRecord(part)) continue;
      if (!isRecord(part["functionCall"])) continue;
      if (isFirst && typeof part["thoughtSignature"] !== "string") {
        part["thoughtSignature"] = SKIP_THOUGHT_SIGNATURE;
      }
      isFirst = false;
    }
  }
}

// Project-id lookup (`loadCodeAssist`) — best-effort, cached

/**
 * Cloud Code Assist metadata sent by native Antigravity control-plane
 * requests. The Gemini CLI sends `IDE_UNSPECIFIED`/`PLATFORM_UNSPECIFIED`/
 * `pluginType=GEMINI`; Antigravity identifies itself as `ANTIGRAVITY`.
 * Sending the Gemini shape makes the backend treat the call as a different
 * client and refuse to enroll the account, which the operator sees as
 * "You do not have a valid license of this product".
 *
 * The reference client (`cloudCodeMainService.js`) sends the full product
 * identity: `ideName`, `ideType`, and `ideVersion`. `ideType` alone was
 * accepted live, but the full shape is the captured wire and avoids any
 * client-class gating on the control plane.
 */
export const ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA = Object.freeze({
  ideName: "antigravity",
  ideType: "ANTIGRAVITY",
  ideVersion: getAntigravityVersion(),
});

const projectIdCache = new Map<string, string>();
const PROJECT_ID_CACHE_MAX = 1024;
function boundProjectIdCache(): void {
  while (projectIdCache.size > PROJECT_ID_CACHE_MAX) {
    const oldest = projectIdCache.keys().next().value;
    if (oldest === undefined) break;
    projectIdCache.delete(oldest);
  }
}
const projectIdInflight = new Map<string, Promise<string | undefined>>();

/** Access-token hash → cache key. Never stores the token itself. */
function tokenKey(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex").slice(0, 32);
}

/**
 * Resolves the caller's Cloud Code Assist project id via
 * `POST /v1internal:loadCodeAssist`. Success is cached per access-token
 * hash for the process lifetime; failures return `undefined` and are not
 * cached so a later dispatch retries. Safe to call from both the OAuth
 * exchange path (warm the cache) and the dispatch path (lazy fetch).
 */
export async function loadAntigravityProject(
  accessToken: string,
  options: {
    readonly baseUrl?: string;
    readonly fetcher?: FetchLike;
    readonly signal?: AbortSignal;
  } = {},
): Promise<string | undefined> {
  const key = tokenKey(accessToken);
  const cached = projectIdCache.get(key);
  if (cached) return cached;
  const inflight = projectIdInflight.get(key);
  if (inflight) return inflight;

  const promise = (async (): Promise<string | undefined> => {
    const fetcher = options.fetcher ?? fetch;
    const base = (options.baseUrl ?? providerBaseUrl("antigravity")).replace(/\/+$/, "");
    try {
      // Full discovery (loadCodeAssist + free-tier onboarding) rather than a
      // bare lookup: an account that never onboarded has no project, and a
      // project-less dispatch is rejected as "You do not have a valid license
      // of this product". Cached per access-token hash, so this runs once per
      // token; best-effort at dispatch, so a failure just yields undefined.
      return await discoverAntigravityProject(accessToken, {
        baseUrl: base,
        fetcher,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch {
      return undefined;
    } finally {
      projectIdInflight.delete(key);
    }
  })();

  projectIdInflight.set(key, promise);
  return promise;
}

function extractProjectId(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const raw = payload["cloudaicompanionProject"];
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (isRecord(raw) && typeof raw["id"] === "string" && raw["id"].length > 0) {
    return raw["id"];
  }
  return undefined;
}

const FREE_TIER_ID = "free-tier";
const ONBOARD_USER_PATH = "/v1internal:onboardUser";
const ONBOARD_OPERATIONS_PATH = "/v1internal";
const ONBOARD_TIMEOUT_MS = 30_000;
// Reference client (`cloudCodeMainService.js`) polls the operation every
// 500ms (`gXa = 500`).
const ONBOARD_POLL_INTERVAL_MS = 500;

/** Thrown when an account cannot be enrolled in the Antigravity free tier. */
export class AntigravityProvisioningError extends Error {
  override readonly name = "AntigravityProvisioningError";
}

function hasTierField(
  payload: Record<string, unknown>,
  field: "currentTier" | "paidTier",
): boolean {
  return payload[field] !== undefined && payload[field] !== null;
}

function isFreeTierAllowed(payload: Record<string, unknown>): boolean {
  const tiers = payload["allowedTiers"];
  return (
    Array.isArray(tiers) &&
    tiers.some((tier) => isRecord(tier) && tier["id"] === FREE_TIER_ID)
  );
}

function freeTierIneligibility(
  payload: Record<string, unknown>,
): { reason: string; validationUrl?: string } | undefined {
  const tiers = payload["ineligibleTiers"];
  if (!Array.isArray(tiers)) return undefined;
  for (const candidate of tiers) {
    if (!isRecord(candidate) || candidate["tierId"] !== FREE_TIER_ID) continue;
    const reason = candidate["reasonMessage"];
    if (typeof reason !== "string" || reason.length === 0) continue;
    const url = candidate["validationUrl"];
    return {
      reason,
      ...(typeof url === "string" && url.length > 0 ? { validationUrl: url } : {}),
    };
  }
  return undefined;
}

/** Asserts the account may enroll in the free tier, mirroring the native client. */
function assertFreeTierEligible(payload: Record<string, unknown>): void {
  if (isFreeTierAllowed(payload)) return;
  const ineligibility = freeTierIneligibility(payload);
  if (ineligibility === undefined) return;
  throw new AntigravityProvisioningError(
    ineligibility.validationUrl === undefined
      ? ineligibility.reason
      : `${ineligibility.reason}\n${ineligibility.validationUrl}`,
  );
}

/** One authenticated Cloud Code Assist control-plane call. */
async function cloudCodeAssistCall(
  fetcher: FetchLike,
  base: string,
  accessToken: string,
  path: string,
  init: { method: "POST" | "GET"; body?: Record<string, unknown> },
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await fetcher(`${base}${path}`, {
    method: init.method,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": getAntigravityUserAgent(),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new AntigravityProvisioningError(
      `${path} failed: ${response.status} ${response.statusText}`,
    );
  }
  const payload = (await response.json()) as unknown;
  return isRecord(payload) ? payload : {};
}

/** Reads the account tier, retrying with the resolved project like the native client. */
async function loadCodeAssist(
  fetcher: FetchLike,
  base: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  let payload = await cloudCodeAssistCall(
    fetcher,
    base,
    accessToken,
    "/v1internal:loadCodeAssist",
    { method: "POST", body: { metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA } },
    signal,
  );
  const projectId = extractProjectId(payload);
  if (!hasTierField(payload, "paidTier") && projectId !== undefined) {
    payload = await cloudCodeAssistCall(
      fetcher,
      base,
      accessToken,
      "/v1internal:loadCodeAssist",
      {
        method: "POST",
        body: {
          cloudaicompanionProject: projectId,
          metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA,
        },
      },
      signal,
    );
  }
  return payload;
}

/** Enrolls the account in the Antigravity free tier, polling until it settles. */
async function onboardUser(
  fetcher: FetchLike,
  base: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + ONBOARD_TIMEOUT_MS;
  const remaining = (): number => {
    const left = deadline - Date.now();
    if (left <= 0) throw new AntigravityProvisioningError("onboardUser timed out");
    return left;
  };
  const projectId = extractProjectId(
    await loadCodeAssist(fetcher, base, accessToken, signal),
  );
  let operation = await cloudCodeAssistCall(
    fetcher,
    base,
    accessToken,
    ONBOARD_USER_PATH,
    {
      method: "POST",
      body: {
        tierId: FREE_TIER_ID,
        ...(projectId === undefined ? {} : { cloudaicompanionProject: projectId }),
        metadata: ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA,
      },
    },
    signal,
  );
  for (;;) {
    if (operation["done"] === true) {
      const error = operation["error"];
      if (isRecord(error) && typeof error["message"] === "string") {
        throw new AntigravityProvisioningError(`onboardUser failed: ${error["message"]}`);
      }
      return;
    }
    const name = operation["name"];
    if (typeof name !== "string" || name.length === 0) {
      throw new AntigravityProvisioningError("onboardUser returned an operation without a name");
    }
    const waited = Promise.withResolvers<void>();
    setTimeout(waited.resolve, Math.min(ONBOARD_POLL_INTERVAL_MS, remaining()));
    await waited.promise;
    operation = await cloudCodeAssistCall(
      fetcher,
      base,
      accessToken,
      `${ONBOARD_OPERATIONS_PATH}/${name}`,
      { method: "GET" },
      signal,
    );
  }
}

/**
 * Resolves the caller's Cloud Code Assist project, enrolling the account in
 * the free tier when it has no tier yet — exactly what the native Antigravity
 * client does after login. Without this step a fresh account has no
 * `cloudaicompanionProject`, and both dispatch and quota calls are rejected
 * with "You do not have a valid license of this product".
 *
 * Throws {@link AntigravityProvisioningError} when the account is ineligible
 * or provisioning fails; the login path surfaces that reason to the operator.
 */
export async function discoverAntigravityProject(
  accessToken: string,
  options: {
    readonly baseUrl?: string;
    readonly fetcher?: FetchLike;
    readonly signal?: AbortSignal;
  } = {},
): Promise<string> {
  const fetcher = options.fetcher ?? fetch;
  const base = (options.baseUrl ?? providerBaseUrl("antigravity")).replace(/\/+$/, "");
  const initial = await loadCodeAssist(fetcher, base, accessToken, options.signal);
  assertFreeTierEligible(initial);
  if (!hasTierField(initial, "currentTier")) {
    await onboardUser(fetcher, base, accessToken, options.signal);
  }
  const refreshed = await loadCodeAssist(fetcher, base, accessToken, options.signal);
  const projectId = extractProjectId(refreshed);
  if (projectId === undefined) {
    throw new AntigravityProvisioningError(
      "loadCodeAssist did not return a cloudaicompanionProject",
    );
  }
  projectIdCache.set(tokenKey(accessToken), projectId);
  boundProjectIdCache();
  return projectId;
}
