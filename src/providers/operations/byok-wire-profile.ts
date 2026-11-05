/**
 * BYOK (bring-your-own-key) custom-provider wire profile.
 *
 * A custom provider row persists only a base URL, an optional compatibility
 * profile, and a default wire family. Everything else the generic
 * OpenAI-compatible adapter needs — which wire families it may serve, which
 * endpoint path each of those uses, and which header carries the operator's
 * credential — is *derived* here, so the catalog registration
 * (`provider-catalog-service`) and the probe fallback (`probing-service`)
 * cannot drift apart.
 *
 * Two wire families authenticate differently, and that is protocol truth, not
 * a per-provider special case: the Anthropic Messages wire reads `x-api-key`,
 * while the OpenAI chat/responses wires read `Authorization: Bearer`.
 */
import type { WireFamily } from "../../protocol/canonical-model";
import type { CompatibilityProfile } from "../provider-metadata";
import { BARE_ROOT_ENDPOINTS, type AuthHeaderShape } from "../../protocol/codecs";

export interface ByokWireProfile {
  /** Header shape the upstream expects for the operator's credential. */
  readonly authHeaderShape: AuthHeaderShape;
  /** Wire families this provider may dispatch; anything else is rejected. */
  readonly supportedWireFamilies: readonly WireFamily[];
  /** Endpoint path per served wire family (bare-root paths). */
  readonly endpointPathsByWireFamily: Partial<Record<WireFamily, string>>;
}

/**
 * Which header carries the credential, derived from the served wires. A
 * provider that serves only Messages is an Anthropic-compatible upstream and
 * gets `x-api-key`; every provider that also serves an OpenAI wire keeps
 * bearer auth, because that is what those wires read.
 */
export function byokAuthHeaderShape(families: readonly WireFamily[]): AuthHeaderShape {
  const servesOpenAiWire = families.some(
    (family) => family === "chat" || family === "responses",
  );
  return !servesOpenAiWire && families.includes("messages") ? "x_api_key" : "authorization_bearer";
}

/**
 * Derives the adapter contract for one BYOK provider.
 *
 * Operator truth wins: an explicit `endpoint_paths_by_wire_family` names
 * exactly the families the provider serves. Without one, the provider serves
 * exactly the family it was created with — a `chat` default serves only chat,
 * a `responses` default only responses, a `messages` default only messages.
 *
 * A `chat` default used to additionally serve `responses`, and discovery then
 * reclassified gpt-5/gpt-6 ids as responses even when the operator picked
 * "Chat completions" — the model ended up on `/v1/responses` (which the
 * upstream may not serve) and the probe timed out. The operator's selection
 * is the contract; nothing is inferred beyond it.
 */
export function resolveByokWireProfile(
  wireFamilyDefault: WireFamily | null | undefined,
  compatibilityProfile: CompatibilityProfile | null | undefined,
): ByokWireProfile {
  const declaredPaths = compatibilityProfile?.endpoint_paths_by_wire_family;
  const declaredFamilies = declaredPaths
    ? (Object.keys(declaredPaths) as WireFamily[])
    : [];
  const defaultFamily: WireFamily = wireFamilyDefault ?? "chat";
  const supportedWireFamilies: readonly WireFamily[] =
    declaredFamilies.length > 0 ? declaredFamilies : [defaultFamily];
  const endpointPathsByWireFamily: Partial<Record<WireFamily, string>> = {};
  for (const family of supportedWireFamilies) {
    const path = declaredPaths?.[family] ?? BARE_ROOT_ENDPOINTS[family];
    if (path !== undefined) endpointPathsByWireFamily[family] = path;
  }
  return {
    authHeaderShape: byokAuthHeaderShape(supportedWireFamilies),
    supportedWireFamilies,
    endpointPathsByWireFamily,
  };
}

/**
 * Endpoint tails an operator may paste into the Base URL field instead of a
 * root. They all end at a per-request path (`/models` is the one exception the
 * model list already handles), so a base carrying one of them cannot be a root
 * and every derived URL — the model list, and the dispatch endpoint joined
 * below it — comes out wrong.
 */
const ENDPOINT_TAIL = /\/(?:v\d+\/)?(?:messages|chat\/completions|responses|completions|embeddings|images\/generations)$/;

/**
 * The root an operator's pasted URL really meant, plus the endpoint tail that
 * was removed.
 *
 * Only the **tail** is stripped. Any path before it belongs to the gateway
 * root and survives, so `https://api.longcat.ai/anthropic/v1/messages`
 * resolves to `https://api.longcat.ai/anthropic` (not the bare origin) — the
 * `/anthropic` prefix is where LongCat actually serves the API. A URL that is
 * already a root comes back with an empty `stripped`.
 */
export function splitEndpointBaseUrl(baseUrl: string): { readonly baseUrl: string; readonly stripped: string } {
  const trimmed = baseUrl.replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { baseUrl: trimmed, stripped: "" };
  }
  const basePath = parsed.pathname.replace(/\/+$/, "");
  const match = ENDPOINT_TAIL.exec(basePath);
  if (match === null) return { baseUrl: trimmed, stripped: "" };
  const keptPath = basePath.slice(0, match.index);
  return { baseUrl: `${parsed.origin}${keptPath}`, stripped: basePath };
}

/**
 * Base URL an operator's model list lives under (`<base>/models`). A bare host
 * has no version segment, so it gets the `/v1` prefix; a base that already
 * carries a path (conventionally `/v1`) is used as-is. A pasted endpoint path
 * is stripped first, so `…/anthropic/v1/messages` discovers at
 * `<origin>/anthropic/v1/models` — the gateway prefix before the endpoint tail
 * belongs to the root and is preserved.
 */
export function modelDiscoveryBaseUrl(baseUrl: string): string {
  // A pasted endpoint has its tail removed; whatever path came before it is a
  // real gateway prefix and stays. A base that already IS a root — bare host,
  // or a version/gateway prefix — keeps that path, because
  // `https://gateway.example/api/v1` legitimately serves its list there.
  const trimmed = baseUrl.replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return `${trimmed}/v1`;
  }
  const basePath = parsed.pathname.replace(/\/+$/, "");
  const match = ENDPOINT_TAIL.exec(basePath);
  const listBase =
    match === null
      ? `${parsed.origin}${basePath}`
      : `${parsed.origin}${basePath.slice(0, match.index)}`;
  if (match !== null || basePath === "" || basePath === "/") return `${listBase}/v1`;
  return listBase;
}

/**
 * URL of an operator's model list (`GET <base>/models`). See
 * `modelDiscoveryBaseUrl` for how the base segment is chosen.
 */
export function modelListUrl(baseUrl: string): string {
  return `${modelDiscoveryBaseUrl(baseUrl)}/models`;
}
