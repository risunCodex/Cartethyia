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

/** Known dialect ids, for validating loose DB/string overrides. */
const KNOWN_DIALECT_IDS = new Set<string>(Object.keys(DEFAULT_DIALECT_POLICIES));

export function resolveDialect(
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
