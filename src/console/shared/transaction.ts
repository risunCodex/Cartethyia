import type { CartethyiaDatabase } from "../../persistence/db-handle";

/**
 * Casts a Drizzle nested-transaction handle to the shared database type.
 *
 * Drizzle types a nested transaction callback with the dialect's own
 * transaction handle, which differs from `CartethyiaDatabase`. The cast is
 * required (both drivers implement the surface stores use), but it is a type
 * hole every time it appears raw — so it is centralized here rather than
 * scattered across call sites.
 */
export function asConsoleDb(tx: unknown): CartethyiaDatabase {
  return tx as unknown as CartethyiaDatabase;
}
