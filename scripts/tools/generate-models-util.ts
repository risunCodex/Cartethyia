/**
 * Shared numeric guards for the packed offline model catalog generator.
 *
 * The packed catalog stores a row's context/output limits in `Uint32Array`
 * columns; a value ≥ 2^32 silently wraps modulo 2^32, so the reader decodes a
 * garbage limit as if it were real. These helpers keep the two feeding
 * functions (`modelsDevRows`, `opencodeRows`) honest and testable without
 * importing `generate-models.ts` (which fetches both upstream catalogs at
 * module load).
 */

/** Positive finite integer, or 0 when the value is not one. */
export function positiveInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/**
 * Upper bound safely storable in a packed-catalog u32 column: strictly below
 * 2^31, so no real token count (or any future source) can reach 2^32 where a
 * `Uint32Array` write wraps.
 */
export const MAX_PACKED_U32_VALUE = 2 ** 31 - 1;

/**
 * Validates one packed-catalog limit column value before it is written.
 *
 * Values ≥ 2^31 would wrap modulo 2^32 in the u32 column, silently corrupting
 * the limit the reader decodes — fail loudly instead of wrapping.
 */
export function checkedPackedLimit(column: "context" | "output", value: number): number {
  if (value >= 2 ** 31) {
    throw new Error(
      `Packed catalog ${column} value ${value} exceeds the safe u32 ceiling ` +
        `(${MAX_PACKED_U32_VALUE}); refusing to wrap`,
    );
  }
  return value;
}
