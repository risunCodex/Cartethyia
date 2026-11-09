// Kiro model discovery.
//
// The account's own model list is authoritative — which models a credential
// reaches depends on the plan it is bound to — and it is served by the Kiro
// control-plane (management) service for a resolved profile. The request is
// scoped by the account's region and profile for the same reason dispatch is.
//
// This surface has its own client identity: it is the IDE's model-list call
// (client `@amzn/kiro-control-plane-bearer-client`), not the agent's chat
// call, and the upstream validates the User-Agent's shape rather than ignoring
// it. In the 1.4.62 build the operation is bound to `GET /List-Available-Models`
// on `https://management.{region}.kiro.dev` (awsJson1_0, `x-amz-target`
// `KiroControlPlaneBearerService.ListAvailableModels`).

import type { FetchLike } from "../../quota/quota-contracts";
import type { ModelDefinition } from "../../provider-model-definition";
import { defineModel } from "../../provider-model-definition";
import {
  buildKiroAmzUserAgent,
  buildKiroRuntimeUserAgent,
  getKiroVersion,
} from "../../operations/client-versions";
import { machineIdForAuthState } from "./kiro-machine-id";
import { resolveKiroProfileArn } from "./kiro-profile";
import {
  AWS_REGION_PATTERN,
  KIRO_DEFAULT_REGION,
  KIRO_EFFORTS,
  KIRO_GENERATE_PATH,
  KIRO_MODELS,
  KIRO_MANAGEMENT_HOST_TEMPLATE,
  kiroTokenTypeHeader,
} from "./kiro-catalog";

/** Longest model list this will read; the upstream sends a few dozen at most. */
const MAX_DISCOVERED_MODELS = 500;

/** The management service target used in `x-amz-target`. */
const KIRO_MANAGEMENT_TARGET = "KiroControlPlaneBearerService.ListAvailableModels" as const;

/**
 * Ids the seed catalog deliberately excludes.
 *
 * Discovery adds every id the upstream lists, so without this a retired row
 * comes back the moment an account fetches its models. The seed is the owner
 * of these ids; the upstream listing is not.
 */
const RETIRED_KIRO_MODEL_IDS: ReadonlySet<string> = new Set([
  "deepseek-3.2",
  "MiniMax-M2.5",
  "qwen3-coder-next",
]);

/** Path the adapter dispatches to; recorded on every discovered row. */
/** Options for one discovery run. */
export interface KiroModelDiscoveryOptions {
  readonly credential: string;
  readonly fetcher?: FetchLike | undefined;
  /** The account's non-secret auth configuration, for its region and profile. */
  readonly authState?: Readonly<Record<string, unknown>> | undefined;
}

/** The account's region and profile, as discovery needs them. */
interface DiscoveryScope {
  readonly region: string;
  readonly profileArn: string;
}

function readScope(authState: Readonly<Record<string, unknown>> | undefined): DiscoveryScope {
  const regionRaw = typeof authState?.["region"] === "string" ? authState["region"].trim() : "";
  const region = AWS_REGION_PATTERN.test(regionRaw) ? regionRaw : KIRO_DEFAULT_REGION;
  const profileArn = resolveKiroProfileArn(authState);
  return { region, profileArn };
}

/**
 * Reads the account's available models.
 *
 * Returns `null` rather than throwing when the catalog cannot be read: discovery
 * is an enrichment over the static seed, and a provider that answers with
 * nothing usable must leave the seeded rows in place instead of failing the sync.
 */
export async function fetchKiroModels(
  options: KiroModelDiscoveryOptions,
): Promise<readonly ModelDefinition[] | null> {
  const credential = options.credential.trim();
  if (credential.length === 0) return null;
  const fetcher = options.fetcher ?? fetch;
  const scope = readScope(options.authState);
  const version = getKiroVersion();
  const machineId = machineIdForAuthState(options.authState);
  const host = KIRO_MANAGEMENT_HOST_TEMPLATE.replace("{region}", scope.region);
  const params = new URLSearchParams({ origin: "AI_EDITOR" });
  if (scope.profileArn.length > 0) params.set("profileArn", scope.profileArn);

  let response: Response;
  try {
    const headers: Record<string, string> = {
      authorization: `Bearer ${credential}`,
      accept: "application/json",
      connection: "close",
      "x-amz-target": KIRO_MANAGEMENT_TARGET,
      "amz-sdk-request": "attempt=1; max=1",
      "amz-sdk-invocation-id": crypto.randomUUID(),
      "user-agent": buildKiroRuntimeUserAgent(version, machineId),
      "x-amz-user-agent": buildKiroAmzUserAgent(version, machineId),
      "x-kiro-machineid": machineId,
    };
    // The management surface labels API-key/enterprise/IdC credentials with
    // `TokenType`; social/Builder-ID sessions send none. Mirror the client's
    // `qje` map and the probe verified against the live service.
    const authMethod = options.authState?.["authMethod"];
    const tokenType = kiroTokenTypeHeader(typeof authMethod === "string" ? authMethod : undefined);
    if (tokenType !== undefined) headers["TokenType"] = tokenType;
    response = await fetcher(`${host}/List-Available-Models?${params.toString()}`, {
      headers,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    await response.text().catch(() => "");
    return null;
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (payload === null || typeof payload !== "object") return null;
  const models = (payload as Record<string, unknown>)["models"];
  if (!Array.isArray(models)) return null;

  const definitions: ModelDefinition[] = [];
  const seen = new Set<string>();
  for (const entry of models.slice(0, MAX_DISCOVERED_MODELS)) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const rawId = record["modelId"] ?? record["id"];
    const modelId = typeof rawId === "string" ? rawId.trim() : "";
    if (modelId.length === 0 || seen.has(modelId) || RETIRED_KIRO_MODEL_IDS.has(modelId)) continue;
    seen.add(modelId);
    const seeded = KIRO_MODELS.find((model) => model.modelId === modelId);
    if (seeded !== undefined) {
      definitions.push(seeded);
      continue;
    }
    const limits = record["tokenLimits"];
    const maxInput =
      limits !== null && typeof limits === "object"
        ? (limits as Record<string, unknown>)["maxInputTokens"]
        : undefined;
    const contextLimit = typeof maxInput === "number" && maxInput > 0 ? Math.trunc(maxInput) : null;
    definitions.push(
      defineModel({
        id: modelId,
        providerId: "kiro",
        wireFamily: "chat",
        endpoint: KIRO_GENERATE_PATH,
        ctx: contextLimit,
        vision: true,
        reasoning: true,
        reasoningEfforts: KIRO_EFFORTS,
        toolCall: true,
      }),
    );
  }
  return definitions.length > 0 ? definitions : null;
}
