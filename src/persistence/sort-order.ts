/**
 * The shared explicit-list-order pattern for console-owned tables.
 *
 * Four stores (`api_key_store`, the model-routing alias and combo stores, the
 * provider-account catalog) grew the same two hand-rolled operations: append a
 * new row at `max(sort_index) + 1`, and rewrite a list's whole order from a
 * client-supplied id sequence. Both live here once.
 *
 * Each call site passes the exact WHERE fragment that scopes one list, because
 * the scopes genuinely differ: tenant-owned tables use `eq(tenant_id, …)`,
 * while the provider-account catalog scopes to `(provider, tenant-or-global)`
 * so a reorder never touches another tenant's rows.
 */
import { and, getTableColumns, inArray, sql, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { CartethyiaDatabase } from "./db-handle";

/** A store handle or an open transaction — both can run selects. */
export type SortOrderDb =
  | CartethyiaDatabase
  | Parameters<Parameters<CartethyiaDatabase["transaction"]>[0]>[0];

/**
 * A table with explicit list ordering. The table's declared column shape is
 * erased on purpose: `nextSortIndex`/`reorderSortIndex` touch only
 * `idColumn`/`sortIndexColumn`, and every caller passes its own schema-typed
 * table plus the two columns.
 */
interface SortOrderTable {
  readonly table: PgTable;
  readonly idColumn: AnyColumn;
  readonly sortIndexColumn: AnyColumn;
}

/** Property name of `sortIndexColumn` on `table` (what `.set()` keys on). */
function sortIndexProperty(order: SortOrderTable): string {
  const columns = getTableColumns(order.table) as Record<string, AnyColumn>;
  for (const [key, value] of Object.entries(columns)) {
    if (value === order.sortIndexColumn) return key;
  }
  throw new Error("sort-order: sortIndexColumn does not belong to table");
}

/**
 * Next free list position: `max(sort_index) + 1`, or `0` for an empty list.
 *
 * A new row appends to the end of the list rather than relying on creation
 * time, so it never displaces existing rows' positions.
 */
export async function nextSortIndex(
  db: SortOrderDb,
  order: SortOrderTable,
  scope: SQL | undefined,
): Promise<number> {
  const rows = await db
    .select({ max: sql<number>`coalesce(max(${order.sortIndexColumn}), -1)` })
    .from(order.table)
    .where(scope);
  return Number(rows[0]?.max ?? -1) + 1;
}

/**
 * Rewrites one scoped list's order in one statement; `ids` is the full
 * desired order. Each named row's index becomes its `sort_index`; rows absent
 * from `ids` keep their old position via the `ELSE` branch. One round trip
 * instead of one UPDATE per id; `CASE` runs on both dialects.
 */
export async function reorderSortIndex(
  db: CartethyiaDatabase,
  order: SortOrderTable,
  scope: SQL | undefined,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const sortIndexKey = sortIndexProperty(order);
  const whens = sql.join(
    ids.map((id, index) => sql`WHEN ${order.idColumn} = ${id} THEN ${index}`),
    sql` `,
  );
  await db
    .update(order.table)
    .set({ [sortIndexKey]: sql`CASE ${whens} ELSE ${order.sortIndexColumn} END` })
    .where(scope === undefined ? inArray(order.idColumn, [...ids]) : and(scope, inArray(order.idColumn, [...ids])));
}
