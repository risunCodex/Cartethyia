/**
 * Tenant-preference request shaping applied after route preparation.
 *
 * Preferences are per-tenant runtime settings (`console_settings.preferences`)
 * that reshape a canonical request before dispatch: thinking normalization and
 * the Responses reasoning-summary override. Shaping failure is deliberately
 * non-fatal — a settings read outage must not fail an otherwise dispatchable
 * request.
 */
import type { CartethyiaDatabase } from "../../persistence/db-handle";
import type { CanonicalRequest } from "../../protocol/canonical-model";
import type { PreparedProxyRequest } from "./preparer";
import { normalizeThinkingConfig } from "../../protocol/translation/thinking";
import { compressRequest } from "./rtk/compress-request";
import { applyInjectSystemPrompt } from "./system-prompt-injection";
import { preferencesReaderFor } from "../../persistence/tenant-preferences";
import {
  readTenantSystemPrompts,
  type StoredTenantSystemPrompts,
} from "../../persistence/system-prompt-store";
import { currentSettingsRevision } from "../../persistence/settings-revision";
import { TtlCache } from "../../persistence/ttl-cache";
import { resolveUpstreamTimeoutMs } from "../../config/timeouts";

/**
 * Revision-keyed cached read of the tenant's system-prompt configuration, the
 * same convergence mechanism as the runtime-preferences reader: a mutation
 * bumps the settings revision, which changes every cache key, so writes are
 * visible to the dispatch path immediately without a per-request round trip.
 */
const systemPromptCache = new TtlCache<StoredTenantSystemPrompts>({
  ttlMs: 5_000,
  maxEntries: 128,
});

async function readTenantSystemPromptsCached(
  db: CartethyiaDatabase,
  tenantId: string,
): Promise<StoredTenantSystemPrompts> {
  const cacheKey = `${tenantId}:${currentSettingsRevision()}`;
  const cached = systemPromptCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const prompts = await readTenantSystemPrompts(db, tenantId);
  systemPromptCache.set(cacheKey, prompts);
  return prompts;
}

/** Cached read for the dispatch path (same revision-keyed cache). */
export { readTenantSystemPromptsCached as readTenantSystemPromptsForDispatch };

/**
 * Re-arms the request deadline from the tenant's timeout override.
 *
 * The initial deadline is armed before authentication, when the tenant is not
 * yet known, so a per-tenant timeout can only be applied here — once the
 * snapshot says who is asking. `extendDeadline` keeps the timer, the state
 * field, and the in-flight record in step, so the backstop sweep cannot
 * force-release a request whose budget legitimately grew.
 *
 * Non-fatal: a settings read outage leaves the deployment default in place
 * rather than failing a dispatchable request.
 */
export async function applyTenantDeadlineOverride(
  tenantId: string,
  db: CartethyiaDatabase,
  extend: (ms: number) => void,
): Promise<void> {
  try {
    const prefs = await preferencesReaderFor(db).readPreferences(tenantId);
    const seconds = prefs?.upstreamTimeoutSeconds;
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return;
    const wanted = Math.floor(seconds * 1000);
    // Only ever shorten or leave alone a deadline that has already begun: an
    // override longer than the default cannot give back time the request has
    // already spent, and arming a longer one would silently extend a budget
    // the caller's own client has likely abandoned.
    const remaining = Math.min(wanted, resolveUpstreamTimeoutMs());
    extend(remaining);
  } catch {
    // Non-fatal
  }
}

/**
 * The tenant's inline-attachment byte ceiling, or `undefined` for the default.
 *
 * Read through the shared revision-keyed preference reader, so the cost is a
 * memory hit rather than a Postgres round trip — this is consulted while
 * building a request body, on the dispatch path.
 *
 * Non-fatal: a settings read outage falls back to the deployment default,
 * which is the safe direction (the default refuses less, but it never admits
 * something no upstream will take).
 */
export async function resolveTenantImageClampMaxBytes(
  db: CartethyiaDatabase,
  tenantId: string | undefined,
): Promise<number | undefined> {
  if (tenantId === undefined) return undefined;
  try {
    const prefs = await preferencesReaderFor(db).readPreferences(tenantId);
    const bytes = prefs?.imageClampMaxBytes;
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return undefined;
    return Math.floor(bytes);
  } catch {
    return undefined;
  }
}

/**
 * The tenant's ordered vision-handoff model list, or `[]` when none is
 * configured (legacy `[image]` placeholder behavior). Read through the shared
 * revision-keyed preference reader; a settings outage yields an empty list,
 * which is the safe direction (handoff is an upgrade, never a prerequisite).
 */
export async function resolveTenantVisionHandoffModels(
  db: CartethyiaDatabase,
  tenantId: string | undefined,
): Promise<readonly string[]> {
  if (tenantId === undefined) return [];
  try {
    const prefs = await preferencesReaderFor(db).readPreferences(tenantId);
    const models = prefs?.visionHandoffModels;
    if (!Array.isArray(models)) return [];
    return models.filter((model): model is string => typeof model === "string" && model.trim().length > 0);
  } catch {
    return [];
  }
}

/**
 * Applies request shaping owned by tenant preferences and deployment config:
 * thinking normalization and the Responses reasoning summary override.
 * Failure is non-fatal.
 */
export async function applyTenantPreferences(
  prepared: PreparedProxyRequest,
  db: CartethyiaDatabase,
): Promise<CanonicalRequest> {
  let canonicalRequest = prepared.canonicalRequest;
  const tenantId = prepared.authorization.snapshot.tenant_id;
  try {
    const prefs = await preferencesReaderFor(db).readPreferences(tenantId);
    if (prefs?.thinkingNormalizationEnabled) {
      const next = normalizeThinkingConfig(canonicalRequest);
      if (next !== canonicalRequest) canonicalRequest = next;
    }
    // Tenant system-prompt injection runs before compression: the PonyTail
    // directive must stay the tail of the system content, and the injected
    // prompt is itself stable per scope, so the prefix-cache invariant holds.
    const prompts = await readTenantSystemPromptsCached(db, tenantId);
    const candidate = prepared.candidate;
    canonicalRequest = applyInjectSystemPrompt(canonicalRequest, prompts, {
      providerId: candidate.provider_id,
      modelId: candidate.model_id,
      serviceKind: candidate.service_kind ?? "llm",
      requestedModel: prepared.plan?.requested_model ?? candidate.model_id,
    });
    if (prefs) {
      // When the routed model is Responses (codex/openai/muse-spark) and the
      // client hit a Chat surface, force the configured summary mode so the
      // Responses wire actually emits a reasoning summary. Default is
      // `detailed` (not encrypted/concise). This runs even when the inbound
      // request carried no `reasoning` block at all.
      const globalSummary = prefs.responsesReasoningSummary;
      const hasResponsesRouteCandidate = prepared.eligibleRouteCandidates.some(
        (c: { wire_family: string }) => c.wire_family === "responses",
      );
      if (globalSummary !== undefined && hasResponsesRouteCandidate) {
        const currentMode = canonicalRequest.reasoning?.summary_mode;
        if (currentMode !== globalSummary) {
          canonicalRequest = {
            ...canonicalRequest,
            reasoning: {
              ...(canonicalRequest.reasoning ?? {}),
              summary_mode: globalSummary,
            },
          };
        }
      }
      // Request compression runs last, after shaping: it prunes tool-result
      // text and appends the PonyTail directive to whatever system content the
      // shaping above settled on, so the directive is not itself reshaped.
      if (prefs.rtkPruneEnabled === true || prefs.ponyTailEnabled === true) {
        const { request } = compressRequest(canonicalRequest, {
          rtkPrune: prefs.rtkPruneEnabled === true,
          rtkLevel: prefs.rtkPruneLevel,
          ponyTail: prefs.ponyTailEnabled === true ? prefs.ponyTailLevel : null,
        });
        canonicalRequest = request;
      }
    }
  } catch {
    // Non-fatal
  }
  return canonicalRequest;
}
