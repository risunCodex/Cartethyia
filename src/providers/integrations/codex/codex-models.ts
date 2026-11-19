/**
 * Codex static model catalog and registry discovery.
 *
 * Kept separate from the Codex adapter so the adapter's protocol graph
 * (`protocol/request/codex`, `protocol/response/codex`, identity headers) is
 * not evaluated merely to materialize the startup model catalog.
 *
 * Split out of `codex.ts`; `codex.ts` re-exports the public symbols so
 * importers keep their existing module path.
 */
import { getCodexVersion } from "../../operations/client-versions";
import { buildCodexUserAgent } from "../../operations/cli-platform";
import { isRecord } from "../../../protocol/codecs";
import type { FetchLike } from "../../quota/quota-contracts";
import { boundedUpstreamArray, boundedUpstreamNumber, sanitizeUpstreamLabel } from "../../provider-sanitize";
import { getCodexAccountId, getCodexResidency } from "./codex-identity";
import { defineModel } from "../../provider-model-definition";
import type { ModelDefinition } from "../../provider-model-definition";

/** ChatGPT backend base URL; shared with the adapter for dispatch. */
export const DEFAULT_CHATGPT_BASE_URL = "https://chatgpt.com";

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
  // Added by operator request (2026-11-19) from the ChatGPT model listing:
  // Responses-wire rows at the 272k context / 128k output the listing reports.
  codexResponsesModel("codex-auto-review", 272_000, 128_000),
  codexResponsesModel("gpt-reserve", 272_000, 128_000),
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

/**
 * Web-search rows served by `/v1/search`. Codex grounds search through a
 * Responses call with a `web_search` tool (see `websearch`); the cheap 5.6
 * SKU is the default search model.
 */
export const CODEX_SEARCH_MODELS: readonly ModelDefinition[] = [
  defineModel({
    id: "gpt-5.6-luna",
    providerId: "codex",
    serviceKind: "websearch",
    wireFamily: "responses",
    // Empty endpoint: the adapter falls back to
    // `/backend-api/codex/responses` when the candidate path is empty (see
    // `dispatch`), and an empty value keeps the row distinct from the llm row
    // in the (provider, model, endpoint) unique key.
    endpoint: "",
    ctx: 1_000_000,
    out: 128_000,
    vision: true,
    reasoning: true,
    toolCall: false,
  }),
];

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
  // Keep the static websearch rows on top of discovered llm rows: the codex
  // registry does not publish search SKUs, and `/v1/search` needs a
  // `service_kind: "websearch"` row to route.
  return [...byId.values(), ...CODEX_SEARCH_MODELS].sort((a, b) => a.modelId.localeCompare(b.modelId));
}
