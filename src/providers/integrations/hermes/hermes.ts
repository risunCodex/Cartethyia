import type { CanonicalRequest } from "../../../protocol/canonical-model";
import type { ProviderDispatchTarget } from "../../provider-contracts";
import type { ApiKeyProviderSpec } from "../../configured-provider";
import { isRecord } from "../../../protocol/codecs";
import { boundedUpstreamArray, boundedUpstreamNumber, sanitizeUpstreamLabel } from "../../provider-sanitize";
import { getHermesVersion } from "../../operations/client-versions";
import { clineReasoningReplayPrepares } from "../buddy/chat";

const HERMES_PROVIDER_ID = "hermes" as const;

/**
 * Portal attribution tags the Nous Research inference API requires.
 *
 * The endpoint validates the *shape* and rejects the request with 400 `missing
 * user tag` when no `user=` tag is present. Measured against the live API:
 *
 *   tags=[user=u1]   → 200      tags=[a=b]   → 400 missing user tag
 *   tags=[user=]     → 200      tags=[x]     → 400 missing user tag
 *   tags=[] / absent → 400      no user tag  → 400
 *
 * The value is not validated — any non-empty value passes — so `user=` is a
 * required field rather than a credential. That matters for what to put in it:
 * a fabricated product name would be a false attribution, and there is no
 * account identity to send, because the inference API exposes no account,
 * usage or quota endpoint (every candidate answers 404). `user=hermes-agent`
 * names the client rather than inventing an end user.
 *
 * `product=` and `client=` are the tags Hermes' own client sends
 * (`agent/portal_tags.py` in `NousResearch/hermes-agent`). Neither is required
 * for dispatch — a request carrying only `user=` answers 200 — but they are
 * sent because they are the client's real attribution and cost nothing. The
 * client version is read from `getHermesVersion()` and sent in the shape the
 * released tags use (`v<version>`): Hermes does not publish a semver, so its
 * versions are date-based release tags.
 */
/**
 * Builds the portal tags for one dispatch.
 *
 * `client=` carries the resolved version in the shape the released tags use
 * (`v<version>`); `getHermesVersion()` tracks the real release.
 */
function hermesPortalTags(): readonly string[] {
  return [
    "product=hermes-agent",
    `client=hermes-client-v${getHermesVersion()}`,
    "user=hermes-agent",
  ];
}

function injectHermesTags(
  payload: Record<string, unknown>,
  _request: CanonicalRequest,
  _candidate: ProviderDispatchTarget,
): void {
  payload["tags"] = hermesPortalTags();
}



import { defineModel } from "../../provider-model-definition";
import type { ModelDefinition } from "../../provider-model-definition";

/**
 * Offline fallback: the free rows as the live catalog last reported them.
 *
 * `loadModelDiscovery` supersedes this list whenever `/v1/models` answers, so
 * these numbers are only read by a fetch that failed. They are the upstream's
 * own `context_length` and `top_provider.max_completion_tokens`, stated per row
 * because they differ per row.
 *
 * Two ids upstream no longer carries are absent: `tencent/hy3:free` (missing
 * from the catalog entirely) and `upstage/solar-pro4:free` (only the billed
 * `upstage/solar-pro4` and the free `upstage/solar-mini4:free` exist).
 */
export const HERMES_MODELS: readonly ModelDefinition[] = [
  // The live `/models` free rows, with the limits the catalog states. Verified
  // against the API: every id here answers 200.
  //
  // `meituan/longcat-2.0:free` is excluded: the catalog still lists the id, but
  // dispatching it answers 404 "This model is no longer free", so listing it
  // would be a card that can only ever fail. `meituan/longcat-2.5:free`
  // is listed instead and answers 200.
  //
  // `stepfun/step-5-preview:free` is excluded: it is absent from the live catalog
  // entirely and dispatching it answers 404 "This model's free period has
  // ended" — a retired row, not a capacity blip, so it cannot be left in.
  //
  // `poolside/laguna-s-2.1:free`, `poolside/laguna-xs-2.1:free`, and
  // `stepfun/step-3.7-flash:free` are removed too: they fail at dispatch.
  defineModel({ id: "upstage/solar-mini4:free", ctx: 524288, out: 131072, reasoning: true, free: true, freeTier: true }),
  defineModel({ id: "reflection/beam-1.0-501b-a23b:free", ctx: 262144, out: 131072, reasoning: true, free: true, freeTier: true }),
  // Vision-corrected against the live catalog: `architecture.input_modalities`
  // lists `image` for this row, so it was published without vision it has.
  defineModel({ id: "meituan/longcat-2.5:free", ctx: 1048576, out: 131072, vision: true, reasoning: true, free: true, freeTier: true }),
];


/**
 * Nous Research (Hermes) — chat-only, with provider-specific portal `tags`
 * injected through the spec's `prePayload` hook. The registry builds the
 * adapter via `createApiKeyAdapter`.
 */
export const HERMES_SPEC: ApiKeyProviderSpec = {
  provider_id: HERMES_PROVIDER_ID,
  endpoint_paths_by_wire_family: {},
  prePayload: (payload, request, candidate) => {
    injectHermesTags(payload, request, candidate);
    for (const prepare of clineReasoningReplayPrepares) prepare(payload);
  },
  // The origin sits behind Cloudflare, which answers a request carrying no
  // `user-agent` with 403 "Attention Required!" while the same request with any
  // non-empty UA answers 200 — measured directly against the API: an empty UA
  // is 403, and `curl`, `node`, `python-requests`, `undici` and Bun's own
  // default are all accepted.
  //
  // The value names this client as Hermes rather than claiming to be the
  // gateway: the upstream meters by the product tag, and the version is the
  // resolved release so a stale pin cannot drift into a mismatch.
  extra_headers: { "user-agent": `hermes-agent/${getHermesVersion()}` },
};

/**
 * Hermes' `/v1/models` is OpenRouter-shaped and needs no credential.
 *
 * It lists the whole reseller catalog (426 rows when this was written) with
 * per-model pricing, while this provider is pinned for its free allowance.
 * Discovery therefore keeps only the rows priced at zero, which is what the
 * static list encoded by hand.
 *
 * Two fields the generic OpenAI-compatible reader misses:
 *
 * - `context_length` sits on the row, so the shared reader would find it, but
 *   the output cap is `top_provider.max_completion_tokens` — not
 *   `max_output_tokens`. Without reading it every row fell back to the generic
 *   64k default and advertised a window the model does not have.
 * - Input modality is `architecture.input_modalities[]`, not a `modality`
 *   string, so a vision row read as text-only.
 */
export async function discoverHermesFreeModels(options: {
  readonly baseUrl: string;
  readonly fetcher?: typeof fetch;
}): Promise<readonly ModelDefinition[] | null> {
  const fetcher = options.fetcher ?? fetch;
  const url = `${options.baseUrl.replace(/\/+$/, "")}/models`;
  const signal = AbortSignal.timeout(10_000);
  let response: Response;
  try {
    response = await fetcher(url, { headers: { accept: "application/json" }, signal });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  const rec = isRecord(payload) ? payload : undefined;
  const rows = rec === undefined ? undefined : boundedUpstreamArray(rec["data"]);
  if (rows === undefined) return null;

  const byId = new Map<string, ModelDefinition>();
  for (const entry of rows) {
    if (!isRecord(entry)) continue;
    const id = sanitizeUpstreamLabel(entry["id"]);
    if (id === undefined) continue;
    if (!isFreePriced(entry)) continue;

    const context = boundedUpstreamNumber(entry["context_length"], { min: 1, max: 1_000_000_000 }) ?? undefined;
    const topProvider = isRecord(entry["top_provider"]) ? entry["top_provider"] : undefined;
    const output =
      boundedUpstreamNumber(topProvider?.["max_completion_tokens"], { min: 1, max: 1_000_000_000 }) ?? undefined;
    const architecture = isRecord(entry["architecture"]) ? entry["architecture"] : undefined;
    const inputs = boundedUpstreamArray(architecture?.["input_modalities"]) ?? [];
    const hasImage = inputs.includes("image");

    byId.set(id, {
      modelId: id,
      wireFamily: "chat",
      endpointPath: "/v1/chat/completions",
      // `null` means "the row states no limit", which is not the same as a
      // guessed number: the routing ladder keeps its own fallback for that.
      contextLimit: context ?? null,
      outputLimit: output ?? null,
      modalities: { input: hasImage ? ["text", "image"] : ["text"], output: ["text"] },
      reasoning: true,
      toolCall: true,
      // The row reached this point only because both rates parse to zero, so
      // it is the free tier by the provider's own pricing. `free` is the
      // billing statement and `freeTier` the catalog one; the model list groups
      // on the tier, so without it these rows land in the fetched tail instead
      // of the free section.
      freeTier: true,
      cost: { input: 0, output: 0, pricing_model: "pay-per-use" },
    });
  }
  return [...byId.values()].sort((a, b) => a.modelId.localeCompare(b.modelId));
}

/**
 * Whether a row is on the free allowance.
 *
 * The catalog spells zero three ways — `"0"`, `"0.0000000000"`, and a missing
 * `pricing` block on a few rows — so the check parses instead of comparing
 * strings. A row with no pricing at all is treated as not free: this provider
 * is pinned for a free allowance, and admitting an unmeasured row would spend
 * the operator's credit.
 */
function isFreePriced(entry: Record<string, unknown>): boolean {
  const pricing = entry["pricing"];
  if (!isRecord(pricing)) return false;
  const prompt = Number(pricing["prompt"]);
  const completion = Number(pricing["completion"]);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return false;
  return prompt === 0 && completion === 0;
}
