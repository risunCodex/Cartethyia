/**
 * Dialect resolver — pure, never throws, always returns a policy.
 *
 * Precedence:
 *   1. explicit DB override (`models.dialect`; passed as `override`)
 *   2. explicit `ModelDefinition.dialect` (passed as `declared`)
 *   3. heuristic rules (`DIALECT_RULES`)
 *   4. family default (`anthropic` for messages, `openai` otherwise)
 *
 * The default policies reproduce today's exact behavior: a request with no
 * dialect set encodes byte-identically to before this layer existed.
 */
import type { WireFamily } from "../../canonical-model";
import { DEFAULT_DIALECT_POLICIES, DIALECT_RULES } from "./rules";
import type { DialectId, DialectPolicy } from "./types";
import { BoundedLruMap } from "../../../transport/routing/bounded-lru";

/** Known dialect ids, for validating loose DB/string overrides. */
const KNOWN_DIALECT_IDS = new Set<string>(Object.keys(DEFAULT_DIALECT_POLICIES));

/**
 * Memoization for `resolveDialect` (mirrors THINKING_RESOLVE_CACHE). The key
 * concatenates every argument, all of which are value types, so it is
 * collision-safe. The cache is a {@link BoundedLruMap}: the key space is
 * bounded by the model catalog, but a request can name an arbitrary model
 * string, so an unbounded map would pin an entry for every miss forever.
 */
const DIALECT_RESOLVE_CACHE_MAX_ENTRIES = 1024;
const DIALECT_RESOLVE_CACHE = new BoundedLruMap<string, DialectPolicy>(
  DIALECT_RESOLVE_CACHE_MAX_ENTRIES,
);

export function resolveDialect(
  modelId: string,
  providerId: string,
  wireFamily: WireFamily,
  override?: string | null,
  declared?: DialectId,
): DialectPolicy {
  const key = `${modelId.toLowerCase()}|${providerId}|${wireFamily}|${override ?? ""}|${declared ?? ""}`;
  const cached = DIALECT_RESOLVE_CACHE.get(key);
  if (cached !== undefined) return cached;
  const policy = resolveDialectUncached(modelId, providerId, wireFamily, override, declared);
  DIALECT_RESOLVE_CACHE.set(key, policy);
  return policy;
}

function resolveDialectUncached(
  modelId: string,
  providerId: string,
  wireFamily: WireFamily,
  override?: string | null,
  declared?: DialectId,
): DialectPolicy {
  const id = pickDialect(modelId, providerId, wireFamily, override, declared);
  const policy = DEFAULT_DIALECT_POLICIES[id];
  if (policy !== undefined) return policy;

  // An unknown dialect id (e.g. from a future DB row) falls back to the
  // family default — never throw, never invent behavior.
  return DEFAULT_DIALECT_POLICIES[familyDefault(wireFamily)];
}

function pickDialect(
  modelId: string,
  providerId: string,
  wireFamily: WireFamily,
  override?: string | null,
  declared?: DialectId,
): DialectId {
  if (override !== undefined && override !== null && KNOWN_DIALECT_IDS.has(override)) {
    return override as DialectId;
  }
  if (declared !== undefined) return declared;
  for (const rule of DIALECT_RULES) {
    if (rule.match(modelId, providerId, wireFamily)) return rule.dialect;
  }
  return familyDefault(wireFamily);
}

function familyDefault(wireFamily: WireFamily): DialectId {
  return wireFamily === "messages" ? "anthropic" : "openai";
}
