/**
 * Builds an object from `source`, omitting absent values.
 *
 * The console domains hand-roll the same `...(x === undefined ? {} : { x })`
 * field-omission spread many times (key create/update patches, response
 * sanitizers). This is the single helper for that pattern; `omitNull` extends
 * it to also drop `null` values (the `== null` variant), matching call sites
 * that treat null as "clear this field" rather than "set it to null".
 */
export function pickDefined<T extends object>(source: T, omitNull = false): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (omitNull && value === null) continue;
    out[key] = value;
  }
  return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}
