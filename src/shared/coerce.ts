/**
 * Shared value-coercion primitives for untyped upstream JSON.
 *
 * These used to exist as private copies in a dozen modules, spelled
 * `record`/`asRecord`/`recordOf`/`isPlainObject` with two different nullish
 * sentinels. One implementation, one sentinel (`undefined`), one place to fix.
 */

/** Narrow an unknown value to a plain (non-array) object, else `undefined`. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Narrow a stored `auth_state`/JSONB value to a plain object. Postgres'
 * drizzle `jsonb` arrives as a POJO; SQLite's text-backed column arrives as
 * a JSON STRING. Parse the string form so both backends hand downstream
 * readers the same shape — otherwise auth-state-dependent providers (Qoder's
 * userId/machineId, Trae's region, …) silently lose their identity on the
 * SQLite backend.
 */
export function asJsonbRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return asRecord(value);
}

/** Narrow to a finite number, else `undefined`. `NaN`/`Infinity` are not numbers here. */
export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Finite number accepting numeric strings (`"42"` → 42). Whitespace-only or
 * non-finite results are `undefined`. This is the "upstream JSON may quote a
 * number" contract; use `asNumber` when strings must stay rejected.
 */
export function asCoercedNumber(value: unknown): number | undefined {
  if (typeof value === "number") return asNumber(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Trim a string-ish value; empty/whitespace-only becomes `undefined`. */
export function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** First non-empty trimmed string among `keys` of `record`. */
export function firstNonEmptyString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = asTrimmedString(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * `JSON.parse` that yields `undefined` instead of throwing, for untyped
 * upstream/console JSON that may be malformed. Non-string/empty input is
 * `undefined` without attempting a parse.
 */
export function tryParseJson(value: string | null | undefined): unknown {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

