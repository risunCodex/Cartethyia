/**
 * Ingress normalization for tool-call arguments (proposal F-4).
 *
 * One logical field, three former verdicts: the Chat surface forwarded any
 * raw string verbatim (`"not json{"` reached the upstream), Responses accepted
 * any JSON value (`arguments: 42`), Messages accepted only an object. Every
 * surface now runs this one normalizer, and the canonical `toolCall.arguments`
 * is always a **string containing a JSON object** — the shape every encoder
 * and request builder already canonicalizes toward.
 *
 * The verdict is repair-or-throw, matching the repair pipeline's own policy
 * (`tool-repair-args.ts`): near-JSON a client bridge legitimately streams — a
 * trailing comma, an unquoted key — is repaired once here so the canonical
 * form is strict JSON, while text that cannot become an object (`"not
 * json{"`, `42`, a bare array) is refused at ingress instead of being
 * forwarded for the upstream to reject with an opaque error. Byte fidelity:
 * a string that already parses to an object is kept verbatim, not
 * re-serialized.
 */

import { isRecord } from "./wire-readers";
import { repairToolArguments } from "./tool-repair-args";

/**
 * Normalizes one tool call's arguments to a JSON-object string.
 *
 * - `undefined`/`null` and blank strings mean "no arguments" → `"{}"`.
 * - A string must parse (or repair) to a JSON object; a caller string that
 *   already parses is kept byte-for-byte.
 * - An object is stringified once, here.
 * - Any other value (number, array, boolean) is rejected.
 *
 * `field` names the wire field for the error message (for example
 * `"tool_call arguments"`), so the 400 tells the caller exactly which entry
 * was malformed.
 */
export function normalizeToolCallArguments(value: unknown, field: string): string {
  if (value === undefined || value === null) return "{}";
  if (typeof value === "string") {
    if (value.trim().length === 0) return "{}";
    if (parsesToObject(value)) return value;
    // Near-JSON gets one repair pass — the same one the encoders apply — so
    // a bridged client's trailing comma becomes strict JSON here instead of
    // relying on every downstream encoder to remember to repair.
    const repaired = repairToolArguments(value);
    if (repaired !== value && parsesToObject(repaired)) return repaired;
    // Two distinct refusals: JSON that is not an object (`42`, `[1]`) is a
    // type error; text that is not JSON at all is a syntax error.
    if (parsesJson(value)) throw new Error(`${field} must be a JSON object`);
    throw new Error(`${field} must be valid JSON`);
  }
  if (isRecord(value)) return JSON.stringify(value);
  throw new Error(`${field} must be a JSON object`);
}

function parsesToObject(text: string): boolean {
  try {
    return isRecord(JSON.parse(text) as unknown);
  } catch {
    return false;
  }
}

function parsesJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
