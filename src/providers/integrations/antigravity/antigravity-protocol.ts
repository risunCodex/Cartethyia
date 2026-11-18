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
import { isRecord } from "../../../protocol/codecs";
import type { CanonicalRequest } from "../../../protocol/canonical-model";
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
  // Gemini 4 Argon effort tiers (real deployment names).
  "gemini-4-argon-low": {
    maxOutputTokens: 65536,
  },
  "gemini-4-argon-medium": {
    maxOutputTokens: 65536,
  },
  "gemini-4-argon-high": {
    maxOutputTokens: 65536,
  },
  // Gemini 4 Hydrogen effort tiers — same deployment shape as Argon.
  "gemini-4-hydrogen-low": {
    maxOutputTokens: 65536,
  },
  "gemini-4-hydrogen-medium": {
    maxOutputTokens: 65536,
  },
  "gemini-4-hydrogen-high": {
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

// Effort-tier vocabulary — the single owner of tier suffixes and the thinking
// budget each tier maps to. Three readers consume it: `antigravityWireModelId`
// (logical id → default-tier deployment), `collapseAntigravityVariant` (wire
// id → logical id), and `antigravityThinkingBudget` (tier → thinkingConfig).

/**
 * Tier suffixes the effort router appends to a deployment id. Order matters:
 * `extra-low` is checked before `low` because it also ends in `-low`.
 */
export const ANTIGRAVITY_EFFORT_SUFFIXES = [
  "extra-low",
  "low",
  "medium",
  "high",
  "tiered",
  "agent",
] as const;

export type AntigravityEffortSuffix = (typeof ANTIGRAVITY_EFFORT_SUFFIXES)[number];

/** Thinking budget the reference client sends per effort tier. */
const ANTIGRAVITY_TIER_THINKING_BUDGET: Readonly<Record<string, number>> = Object.freeze({
  low: 1_000,
  medium: 4_000,
  high: 10_000,
});

/**
 * Default effort tier each logical id deploys as at dispatch (the wire id is
 * `<id>-<tier>`). Ids not listed here are already wire ids and pass through.
 */
const ANTIGRAVITY_DEFAULT_TIER: Readonly<Record<string, AntigravityEffortSuffix>> = Object.freeze({
  "gemini-3.6-flash": "low",
  "gemini-3.7-flash": "low",
  "gemini-3.8-flash": "low",
  "gemini-4-argon": "low",
  "gemini-4-hydrogen": "medium",
  "gpt-oss-120b": "medium",
});

/** The tier suffix a (logical or wire) model id carries, if any. */
export function antigravityTierSuffix(modelId: string): AntigravityEffortSuffix | undefined {
  for (const suffix of ANTIGRAVITY_EFFORT_SUFFIXES) {
    if (modelId.endsWith(`-${suffix}`)) return suffix;
  }
  return undefined;
}

/**
 * Thinking budget for a model id, matching the client's effort tiers: a
 * tier-suffixed id gets that tier's budget, a bare id the client's default.
 *
 * Applies to Claude routes and Gemini 3+ SKUs — the gemini-4 family included,
 * since those deployments are thinking-capable on their `-low`/`-medium`/
 * `-high` ids. Earlier Gemini SKUs and GPT-OSS send no `thinkingConfig`.
 */
export function antigravityThinkingBudget(modelId: string): number | undefined {
  if (!modelId.includes("claude") && !isGemini3Plus(modelId)) return undefined;
  const tier = antigravityTierSuffix(modelId);
  const budget = tier === undefined ? undefined : ANTIGRAVITY_TIER_THINKING_BUDGET[tier];
  if (budget !== undefined) return budget;
  return modelId.includes("3.1-pro") ? 10_001 : 10_000;
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
  const tier = ANTIGRAVITY_DEFAULT_TIER[modelId];
  return tier === undefined ? modelId : `${modelId}-${tier}`;
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

// Model discovery (`v1internal:fetchAvailableModels`) lives in
// `./antigravity-discovery`; re-exported here so existing import sites are
// unchanged.
export {
  ANTIGRAVITY_SANDBOX_BASE,
  collapseAntigravityVariant,
  discoverAntigravityModels,
} from "./antigravity-discovery";

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

// Project-id lookup (`loadCodeAssist`) and free-tier provisioning live in
// `./antigravity-provision`; `antigravity-protocol.ts` re-exports them so
// existing import sites (`antigravity.ts`, `antigravity-quota.ts`,
// `antigravity-oauth.ts`, `default-registry.ts`) are unchanged.
//
// `ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA` stays here: it snapshots
// `getAntigravityVersion()` at module evaluation, and keeping it on this side
// of the edge keeps `antigravity-provision` a pure consumer of the protocol
// module (provision → protocol, never the reverse at eval time).
export const ANTIGRAVITY_LOAD_CODE_ASSIST_METADATA = Object.freeze({
  ideName: "antigravity",
  ideType: "ANTIGRAVITY",
  ideVersion: getAntigravityVersion(),
});
export {
  AntigravityProvisioningError,
  loadAntigravityProject,
  discoverAntigravityProject,
} from "./antigravity-provision";
