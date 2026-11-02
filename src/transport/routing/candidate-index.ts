// Immutable per-snapshot candidate index for model resolution.
import type { RouteCandidate, RouteSnapshot } from "./route-model";

/** One parsed model reference: `provider/model` or a bare `model`. */
interface ParsedModel {
  readonly providerId: string | null;
  readonly modelId: string;
}

/** Parse one model reference into its provider and bare model id. */
export function parseModelReference(model: string): ParsedModel {
  const slash = model.indexOf("/");
  if (slash === -1) return { providerId: null, modelId: model };
  return { providerId: model.slice(0, slash), modelId: model.slice(slash + 1) };
}

/**
 * An immutable, per-snapshot index of route candidates.
 *
 * Snapshots are immutable by contract (rebuilt wholesale on catalog change),
 * so the index is built once per snapshot — O(C) — and reused by every plan,
 * instead of the previous behavior of rescanning the full candidate list per
 * resolved model inside one plan: a combo with K unique members over C
 * candidates cost K×C `candidateMatches` calls (each re-parsing the model
 * string), repeated on every request.
 */
interface RouteCandidateIndex {
  /** Candidates keyed by `provider_id/model_id`, snapshot order preserved. */
  readonly qualified: ReadonlyMap<string, readonly RouteCandidate[]>;
  /** Candidates keyed by bare `model_id`, snapshot order preserved. */
  readonly bare: ReadonlyMap<string, readonly RouteCandidate[]>;
}

/** WeakMap cache: an evicted/rebuilt snapshot releases its index automatically. */
const indexBySnapshot = new WeakMap<RouteSnapshot, RouteCandidateIndex>();

/**
 * Builds (once per snapshot) the lookup index for `resolveMatchingCandidates`.
 *
 * Each candidate is visited exactly once and filed under both its qualified and
 * bare key, so a lookup later is one `Map.get` regardless of catalog size.
 * Snapshot order is preserved within each bucket because `Map` iterates in
 * insertion order and candidates are appended in one pass.
 */
export function routeCandidateIndex(snapshot: RouteSnapshot): RouteCandidateIndex {
  const cached = indexBySnapshot.get(snapshot);
  if (cached) return cached;
  const qualified = new Map<string, RouteCandidate[]>();
  const bare = new Map<string, RouteCandidate[]>();
  for (const candidate of snapshot.candidates) {
    const qualifiedKey = `${candidate.provider_id}/${candidate.model_id}`;
    const qualifiedList = qualified.get(qualifiedKey);
    if (qualifiedList) qualifiedList.push(candidate);
    else qualified.set(qualifiedKey, [candidate]);

    const bareList = bare.get(candidate.model_id);
    if (bareList) bareList.push(candidate);
    else bare.set(candidate.model_id, [candidate]);
  }
  const index: RouteCandidateIndex = { qualified, bare };
  indexBySnapshot.set(snapshot, index);
  return index;
}

/**
 * Looks up the candidates a parsed model reference resolves to, filtered by
 * tenant.
 *
 * A qualified reference (`provider/model`) reads the exact bucket and requires
 * the provider to match; a bare reference reads every provider's bucket for
 * that model. The tenant rule is the resolver's existing one, unchanged:
 * a candidate is visible only when it is global (`tenant_id == null`) or
 * belongs to the requesting tenant.
 */
export function lookupRouteCandidates(
  index: RouteCandidateIndex,
  parsedModel: ParsedModel,
  tenantId: string | null,
): readonly RouteCandidate[] {
  const group =
    parsedModel.providerId === null
      ? index.bare.get(parsedModel.modelId)
      : index.qualified.get(`${parsedModel.providerId}/${parsedModel.modelId}`);
  if (group === undefined || group.length === 0) return [];
  return group.filter(
    (candidate) => candidate.tenant_id == null || candidate.tenant_id === tenantId,
  );
}
