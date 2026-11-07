import { asNumber as sharedAsNumber, asRecord } from "../../../shared/coerce";

/**
 * Model discovery for the buddy family (CodeBuddy intl / CN).
 *
 * The two sites are protocol-isomorphic but NOT path-isomorphic, and the
 * difference is load-bearing: the international site answers
 * `/v2/enterprises/personal/models`, while the CN site answers
 * `/console/enterprises/personal/models`. Probing the CN path on an
 * international host returns HTTP 500 from the edge (APISIX) rather than 404 —
 * so a single shared path silently fails every intl sync while looking like an
 * upstream outage.
 *
 * Both shapes answer `{ code, msg, data: { models, agents } }`, not the OpenAI
 * `{data:[…]}` envelope the shared OpenAI-compatible discovery reads, which is
 * why this needs its own reader.
 *
 * Two filters decide what is actually callable, and both come from the payload:
 * - `disabled` rows are advertised but not served;
 * - when an `agents` entry named `cli` carries a model list, that list is the
 *   roster the CLI identity may call. The console publishes models a web
 *   session can reach but a CLI token cannot, and listing those would offer
 *   routes that answer with an upstream rejection.
 *
 * The static catalog beside each provider stays as the fallback for a site
 * whose directory is unreachable: discovery adds and corrects rows, it does not
 * replace the bundled list.
 */
import type { ModelDefinition } from "../../provider-model-definition";
import { makeBuddyModel, type BuddyRawEntry } from "./buddy-catalog-shared";
import { buddyAccountUid } from "./buddy-oauth-shared";

/** Console directory path on the CN site (`copilot.tencent.com`). */
export const BUDDY_CN_MODELS_PATH = "/console/enterprises/personal/models" as const;

/**
 * Console directory path on the international site (`codebuddy.ai`). The CN
 * path above answers 500 on these hosts.
 */
export const BUDDY_INTL_MODELS_PATH = "/v2/enterprises/personal/models" as const;

/**
 * Remote config path, answered on every realm's chat host.
 *
 * Both reference gateways treat this as the primary model catalog and the
 * personal-models paths above as the narrower fallback: `/v3/config` carries
 * the same `{ code, msg, data: { models, agents } }` envelope plus the
 * per-product rosters the personal path does not always publish. It is tried
 * first, and a failure falls through to the path the caller already passes, so
 * a host that does not answer it behaves exactly as it does today.
 */
export const BUDDY_CONFIG_PATH = "/v3/config" as const;

/** Envelope code the console directory answers on success. */
const BUDDY_OK_CODE = 0;

interface BuddyDirectoryRow {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly disabled?: unknown;
  readonly maxInputTokens?: unknown;
  readonly maxOutputTokens?: unknown;
  readonly supportsImages?: unknown;
  readonly supportsToolCall?: unknown;
  readonly supportsReasoning?: unknown;
  readonly tags?: unknown;
}

/**
 * Strips the version segment a provider's base URL carries so a directory path
 * that starts with its own `/v2` does not join into `/v2/v2/…`.
 *
 * The CodeBuddy intl base URL is `https://www.codebuddy.ai/v2` (the chat
 * endpoint is the version-less `/chat/completions` under it), while the model
 * directory lives at the absolute `/v2/enterprises/personal/models`. Joining
 * the two verbatim doubles the segment and the edge answers 404.
 */
function siteOrigin(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v\d+$/, "");
}

function asNumber(value: unknown): number | null {
  return sharedAsNumber(value) ?? null;
}

/**
 * Reads one site's console directory into catalog rows.
 *
 * Returns `null` when the endpoint is unusable (non-200, unparseable body, or a
 * non-zero envelope code) so the caller reports a failed sync instead of
 * persisting an empty roster over a working catalog.
 */
export async function fetchBuddyDirectoryModels(args: {
  readonly siteUrl: string;
  readonly providerId: string;
  readonly credential: string;
  readonly modelsPath: string;
  readonly endpoint: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly fetcher?: typeof fetch | undefined;
}): Promise<readonly ModelDefinition[] | null> {
  const fetcher = args.fetcher ?? globalThis.fetch;
  // Fetch both catalog scopes and merge them. `/v3/config` is ranked higher and
  // is the primary source (matches the reference gateways), but the personal
  // models path carries models the v3 response does not always publish — so a
  // single-source read can silently miss models that are callable. Merging with
  // dedupe by model id gives the union, mirroring the upstream codebuddy2api
  // catalog aggregation. Each failure falls through to the other source, so a
  // host that answers only one behaves exactly as it does today.
  const v3 = await fetchBuddyDirectoryOnce(args, fetcher, BUDDY_CONFIG_PATH);
  const personal = await fetchBuddyDirectoryOnce(args, fetcher, args.modelsPath);
  if (v3 !== null && personal !== null) return mergeBuddyDirectories(v3, personal);
  return v3 ?? personal;
}

/**
 * Merges two buddy directory reads into one roster, preserving each source's
 * declaration order and de-duplicating by model id. `primary` wins when both
 * sources declare the same id; models present only in `supplemental` are
 * appended. Both lists are already filtered (disabled/CLI-roster/not-chat),
 * so the merge only has to combine them.
 */
function mergeBuddyDirectories(
  primary: readonly ModelDefinition[],
  supplemental: readonly ModelDefinition[],
): readonly ModelDefinition[] {
  const seen = new Set<string>();
  const merged: ModelDefinition[] = [];
  for (const model of primary) {
    if (seen.has(model.modelId)) continue;
    seen.add(model.modelId);
    merged.push(model);
  }
  for (const model of supplemental) {
    if (seen.has(model.modelId)) continue;
    seen.add(model.modelId);
    merged.push(model);
  }
  return merged;
}

/** Reads one directory path; `null` on any transport, status, or shape miss. */
async function fetchBuddyDirectoryOnce(
  args: {
    readonly siteUrl: string;
    readonly providerId: string;
    readonly credential: string;
    readonly endpoint: string | undefined;
    readonly signal?: AbortSignal | undefined;
  },
  fetcher: typeof fetch,
  path: string,
): Promise<readonly ModelDefinition[] | null> {
  // The directory scores by account: an access token's `sub` is the uid. An
  // opaque API key carries no identity, and the endpoint still answers for it,
  // so the header is declared absent rather than guessed.
  const uid = buddyAccountUid(args.credential);
  let response: Response;
  try {
    response = await fetcher(`${siteOrigin(args.siteUrl)}${path}`, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${args.credential}`,
        "x-product": "SaaS",
        ...(uid === undefined ? { "x-no-user-id": "1" } : { "x-user-id": uid }),
        "x-no-enterprise-id": "1",
        "x-no-department-info": "1",
      },
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  const envelope = asRecord(body);
  if (envelope === undefined || envelope["code"] !== BUDDY_OK_CODE) return null;
  const data = asRecord(envelope["data"]);
  const rawModels = data?.["models"];
  if (!Array.isArray(rawModels)) return null;

  // The CLI agent's roster, when published, is the callable subset.
  const agents = data?.["agents"];
  let cliRoster: Set<string> | undefined;
  if (Array.isArray(agents)) {
    for (const entry of agents) {
      const agent = asRecord(entry);
      if (agent?.["name"] !== "cli") continue;
      const listed = agent["models"];
      if (Array.isArray(listed) && listed.length > 0) {
        cliRoster = new Set(listed.filter((id): id is string => typeof id === "string"));
      }
      break;
    }
  }

  const entries: BuddyRawEntry[] = [];
  const seen = new Set<string>();
  for (const entry of rawModels) {
    const model = asRecord(entry) as BuddyDirectoryRow | undefined;
    const id = model?.id;
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    if (model?.disabled === true) continue;
    // Completion, NES, and codewise rows are not chat models. Listing them
    // offers a route that 400s on a chat request. A declared output of 256 or
    // less is the same signal: a completion model published with a chat-sized
    // name. `text-to-image` is an image row, served by the image roster.
    const lowerId = id.toLowerCase();
    if (lowerId.startsWith("nes-") || lowerId.startsWith("completion-") || lowerId.startsWith("codewise-")) continue;
    const output = asNumber(model?.maxOutputTokens);
    if (output !== null && output <= 256) continue;
    const tags = model?.tags;
    if (Array.isArray(tags) && tags.some((tag) => typeof tag === "string" && tag.toLowerCase() === "text-to-image")) continue;
    if (cliRoster !== undefined && !cliRoster.has(id)) continue;
    seen.add(id);
    entries.push([
      id,
      typeof model?.name === "string" && model.name.length > 0 ? model.name : id,
      model?.supportsReasoning === true,
      model?.supportsImages === true,
      asNumber(model?.maxInputTokens),
      asNumber(model?.maxOutputTokens),
      model?.supportsToolCall === true,
    ]);
  }
  if (entries.length === 0) return null;
  return entries.map((entry) => makeBuddyModel(entry, args.providerId, args.endpoint));
}
