// Persisted API-key store: the console API-key domain and gateway authentication both consume this boundary.

import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { nextSortIndex, reorderSortIndex, type SortOrderDb } from "../sort-order";
import { getDbHandle } from "../boot";
import type { CartethyiaDatabase } from "../db-handle";
import { lockRows } from "../dialect";
import { apiKeys, shareLinks, sharePopups, telemetryUsageTotals, type ApiKeyMode, type ApiKeyModelAccessMode, type ApiKeyConcurrencyScope } from "../schema";
import type { AccessScope } from "../../security/access-control";

/** Sortable columns for the paged share-child listing (api_keys columns only). */
export type SharedChildSortColumn =
  | "createdAt"
  | "label"
  | "keyPrefix"
  | "issuedClientIp"
  | "revokedAt"
  | "enabled";

export interface SharedChildrenPageOptions {
  readonly limit: number;
  readonly offset: number;
  readonly sortBy: SharedChildSortColumn;
  readonly order: "asc" | "desc";
  readonly status: "all" | "active" | "revoked";
}

export interface SharedChildrenPage {
  readonly rows: readonly ApiKeyRecord[];
  readonly total: number;
  readonly active: number;
  readonly revoked: number;
  /** Family-wide `lifetime_tokens_consumed` sum, independent of the page. */
  readonly consumed: number;
}

/**
 * SQL predicate: the key is not under an active ban. A ban is active while
 * `banned_at` is set AND either `banned_until` is null (permanent) or still in
 * the future — so a timed ban lapses on its own without a sweep.
 */
function notBannedSql(): SQL {
  return or(
    isNull(apiKeys.bannedAt),
    and(isNotNull(apiKeys.bannedUntil), lte(apiKeys.bannedUntil, new Date())),
  ) as SQL;
}

/** Persisted API key. Only its one-way hash authenticates; plaintext is never stored. */
export interface ApiKeyRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly keyHash: string | null;
  readonly keyMode: ApiKeyMode;
  readonly parentKeyId?: string;
  readonly issuedClientIp?: string;
  readonly issuedClientIpKey?: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly scopes: readonly AccessScope[];
  /** The tenant's mandatory gateway key: rotatable, never revocable. */
  readonly isDefault: boolean;
  /** Non-secret prefix configured on a key or used to identify a share child. */
  readonly keyPrefix?: string;
  /** Encrypted copy exists only for personal keys used by CLI handoff. */
  readonly keyEncrypted?: Buffer;
  readonly notesTitle?: string;
  readonly notesSubtitle?: string;
  readonly notesBody?: string;
  readonly sharePopupEnabled?: boolean;
  /** Uploaded popup art; served from the share page rather than a remote URL. */
  readonly sharePopupImage?: Buffer;
  readonly sharePopupImageMime?: string;
  readonly sharePopupTitle?: string;
  readonly sharePopupBody?: string;
  readonly requestsPerMinute?: number;
  readonly dailyTokenLimit?: number;
  readonly monthlyTokenLimit?: number;
  readonly lifetimeTokenBudget?: number;
  readonly maxConcurrentRequests?: number;
  readonly concurrencyScope?: ApiKeyConcurrencyScope;
  /** Share-template recipient slot cap; undefined = unlimited. */
  readonly maxChildren?: number;
  readonly modelPrefix?: string;
  readonly modelAccessMode?: ApiKeyModelAccessMode;
  readonly modelList?: readonly string[];
  /** Client-router ids this key refuses; see the schema column for the contract. */
  readonly clientRouterDenylist?: readonly string[];
  readonly createdAt: Date;
  readonly revokedAt?: Date;
  /** Ban state; see the schema column for the contract. */
  readonly bannedAt?: Date;
  readonly banReason?: string;
  /** When the ban lifts on its own; null means permanent. */
  readonly bannedUntil?: Date;
  readonly tokensConsumed: number;
}

type SharedChildSortColumnRef =
  | typeof apiKeys.createdAt
  | typeof apiKeys.label
  | typeof apiKeys.keyPrefix
  | typeof apiKeys.issuedClientIp
  | typeof apiKeys.revokedAt
  | typeof apiKeys.enabled;

const SHARED_CHILD_SORT_COLUMNS: Readonly<Record<SharedChildSortColumn, SharedChildSortColumnRef>> = {
  createdAt: apiKeys.createdAt,
  label: apiKeys.label,
  keyPrefix: apiKeys.keyPrefix,
  issuedClientIp: apiKeys.issuedClientIp,
  revokedAt: apiKeys.revokedAt,
  enabled: apiKeys.enabled,
};

/**
 * Partial key update. Nullable policy fields clear their values; `undefined`
 * leaves them unchanged. Credential metadata is writable only for a mode
 * transition performed by the API-key domain.
 */
export interface ApiKeyPatch
  extends Omit<
    Partial<ApiKeyRecord>,
    | "id"
    | "tenantId"
    | "keyHash"
    | "parentKeyId"
    | "issuedClientIp"
    | "issuedClientIpKey"
    | "createdAt"
    | "revokedAt"
    | "tokensConsumed"
    | "keyEncrypted"
    | "keyPrefix"
    | "notesTitle"
    | "notesSubtitle"
    | "notesBody"
    | "sharePopupEnabled"
    | "sharePopupImage"
    | "sharePopupImageMime"
    | "sharePopupTitle"
    | "sharePopupBody"
    | "requestsPerMinute"
    | "dailyTokenLimit"
    | "monthlyTokenLimit"
    | "lifetimeTokenBudget"
    | "maxConcurrentRequests"
    | "maxChildren"
    | "bannedAt"
    | "banReason"
    | "bannedUntil"
  > {
  readonly keyHash?: string | null;
  readonly keyEncrypted?: Buffer | null;
  readonly keyPrefix?: string | null;
  readonly notesTitle?: string | null;
  readonly notesSubtitle?: string | null;
  readonly notesBody?: string | null;
  readonly sharePopupEnabled?: boolean | null;
  /** Null clears both bytes and mime; setting one without the other is rejected upstream. */
  readonly sharePopupImage?: Buffer | null;
  readonly sharePopupImageMime?: string | null;
  readonly sharePopupTitle?: string | null;
  readonly sharePopupBody?: string | null;
  readonly requestsPerMinute?: number | null;
  readonly dailyTokenLimit?: number | null;
  readonly monthlyTokenLimit?: number | null;
  readonly lifetimeTokenBudget?: number | null;
  readonly maxConcurrentRequests?: number | null;
  readonly maxChildren?: number | null;
  /** Ban state; a ban also disables the key, unban clears both columns entirely. */
  readonly bannedAt?: Date | null;
  readonly banReason?: string | null;
  /** When the ban lifts on its own; null (explicit) means permanent. */
  readonly bannedUntil?: Date | null;
}

interface PopupFields {
  readonly sharePopupEnabled?: boolean | null;
  readonly sharePopupImage?: Buffer | null;
  readonly sharePopupImageMime?: string | null;
  readonly sharePopupTitle?: string | null;
  readonly sharePopupBody?: string | null;
}

function popupPatchTouched(patch: PopupFields): boolean {
  return (
    patch.sharePopupEnabled !== undefined ||
    patch.sharePopupImage !== undefined ||
    patch.sharePopupImageMime !== undefined ||
    patch.sharePopupTitle !== undefined ||
    patch.sharePopupBody !== undefined
  );
}

/** Merges a partial popup patch onto the stored row, so an omitted field is kept. */
async function mergeSharePopup(
  db: CartethyiaDatabase,
  apiKeyId: string,
  patch: PopupFields,
): Promise<void> {
  const existing = await db
    .select()
    .from(sharePopups)
    .where(eq(sharePopups.apiKeyId, apiKeyId))
    .limit(1);
  const row = existing[0];
  await writeSharePopup(db, apiKeyId, {
    sharePopupEnabled: patch.sharePopupEnabled !== undefined ? patch.sharePopupEnabled : (row?.enabled ?? false),
    sharePopupImage: patch.sharePopupImage !== undefined ? patch.sharePopupImage : (row?.image ?? null),
    sharePopupImageMime: patch.sharePopupImageMime !== undefined ? patch.sharePopupImageMime : (row?.imageMime ?? null),
    sharePopupTitle: patch.sharePopupTitle !== undefined ? patch.sharePopupTitle : (row?.title ?? null),
    sharePopupBody: patch.sharePopupBody !== undefined ? patch.sharePopupBody : (row?.body ?? null),
  });
}

/** Writes the popup row, or removes it when the owner cleared every field. */
async function writeSharePopup(
  db: CartethyiaDatabase,
  apiKeyId: string,
  fields: PopupFields,
): Promise<void> {
  const enabled = fields.sharePopupEnabled ?? false;
  const image = fields.sharePopupImage ?? null;
  const title = fields.sharePopupTitle ?? null;
  const body = fields.sharePopupBody ?? null;
  if (!enabled && image === null && title === null && body === null) {
    await db.delete(sharePopups).where(eq(sharePopups.apiKeyId, apiKeyId));
    return;
  }
  await db
    .insert(sharePopups)
    .values({
      apiKeyId,
      enabled,
      image,
      imageMime: fields.sharePopupImageMime ?? null,
      title,
      body,
    })
    .onConflictDoUpdate({
      target: sharePopups.apiKeyId,
      set: {
        enabled,
        image,
        imageMime: fields.sharePopupImageMime ?? null,
        title,
        body,
      },
    });
}

/** Explicit persistence boundary. Production must provide this; there is no fallback store. */
export interface ApiKeyStore {
  list(tenantId: string): Promise<readonly ApiKeyRecord[]>;
  get(tenantId: string, keyId: string): Promise<ApiKeyRecord | undefined>;
  listChildren(tenantId: string, parentKeyId: string): Promise<readonly ApiKeyRecord[]>;
  revokeChildrenByScope(
    tenantId: string,
    parentKeyId: string,
    scope: "active" | "unused",
  ): Promise<number>;
  /** Cumulative family spend: template counter + every telemetry total row ever
   * recorded for the family (revoked/deleted children stay counted). */
  sumFamilyTelemetryConsumed(tenantId: string, parentKeyId: string): Promise<number>;
  listChildrenPage(
    tenantId: string,
    parentKeyId: string,
    options: SharedChildrenPageOptions,
  ): Promise<SharedChildrenPage>;
  create(record: ApiKeyRecord): Promise<void>;
  /** Rewrites list order for one tenant; `keyIds` is the full desired order. */
  reorder(tenantId: string, keyIds: readonly string[]): Promise<void>;
  update(tenantId: string, keyId: string, patch: ApiKeyPatch): Promise<ApiKeyRecord | undefined>;
  revoke(tenantId: string, keyId: string, revokedAt: Date): Promise<boolean>;
  /**
   * Bans a key: records the operator's reason and (optionally) an expiry.
   * `bannedUntil` null means permanent; absent defaults the the caller's
   * choice. Returns false when the key is already revoked (a revoke is
   * terminal).
   */
  ban(
    tenantId: string,
    keyId: string,
    reason: string,
    bannedUntil?: Date | null,
  ): Promise<boolean>;
  /** Unbans a key: clears the ban columns entirely — no metadata remains. */
  unban(tenantId: string, keyId: string): Promise<boolean>;
  remove(tenantId: string, keyId: string): Promise<boolean>;
  findActiveByHash?(hash: string): Promise<typeof apiKeys.$inferSelect | undefined>;
  findActiveById?(keyId: string): Promise<typeof apiKeys.$inferSelect | undefined>;
  sumChildrenConsumed?(parentKeyId: string): Promise<number>;
}

export class DrizzleApiKeyStore implements ApiKeyStore {
  constructor(private readonly db: CartethyiaDatabase) {}

  /** Attaches the popup, which lives in its own table so the auth read never loads it. */
  private async withPopups(
    db: SortOrderDb | CartethyiaDatabase,
    rows: readonly (typeof apiKeys.$inferSelect)[],
  ): Promise<ApiKeyRecord[]> {
    if (rows.length === 0) return [];
    const popups = await db
      .select()
      .from(sharePopups)
      .where(inArray(sharePopups.apiKeyId, rows.map((row) => row.id)));
    const byKey = new Map(popups.map((popup) => [popup.apiKeyId, popup]));
    return rows.map((row) => this.map(row, byKey.get(row.id)));
  }

  private map(
    row: typeof apiKeys.$inferSelect,
    popup?: typeof sharePopups.$inferSelect,
  ): ApiKeyRecord {
    return {
      id: row.id,
      tenantId: row.tenantId,
      keyHash: row.keyHash,
      keyMode: row.keyMode,
      isDefault: row.isDefault,
      ...(row.parentKeyId === null ? {} : { parentKeyId: row.parentKeyId }),
      ...(row.issuedClientIp === null ? {} : { issuedClientIp: row.issuedClientIp }),
      ...(row.issuedClientIpKey === null
        ? {}
        : { issuedClientIpKey: row.issuedClientIpKey }),
      label: row.label,
      enabled: row.enabled,
      scopes: row.scopes as ApiKeyRecord["scopes"],
      ...(row.keyPrefix === null ? {} : { keyPrefix: row.keyPrefix }),
      ...(row.keyEncrypted === null ? {} : { keyEncrypted: row.keyEncrypted }),
      ...(row.notesTitle === null ? {} : { notesTitle: row.notesTitle }),
      ...(row.notesSubtitle === null ? {} : { notesSubtitle: row.notesSubtitle }),
      ...(row.notesBody === null ? {} : { notesBody: row.notesBody }),
      ...(popup?.enabled ? { sharePopupEnabled: popup.enabled } : {}),
      ...(popup?.image == null ? {} : { sharePopupImage: popup.image }),
      ...(popup?.imageMime == null ? {} : { sharePopupImageMime: popup.imageMime }),
      ...(popup?.title == null ? {} : { sharePopupTitle: popup.title }),
      ...(popup?.body == null ? {} : { sharePopupBody: popup.body }),
      ...(row.requestsPerMinute === null ? {} : { requestsPerMinute: row.requestsPerMinute }),
      ...(row.dailyTokenLimit === null ? {} : { dailyTokenLimit: row.dailyTokenLimit }),
      ...(row.monthlyTokenLimit === null ? {} : { monthlyTokenLimit: row.monthlyTokenLimit }),
      ...(row.lifetimeTokenBudget === null ? {} : { lifetimeTokenBudget: row.lifetimeTokenBudget }),
      ...(row.maxConcurrentRequests === null
        ? {}
        : { maxConcurrentRequests: row.maxConcurrentRequests }),
      ...(row.concurrencyScope
        ? { concurrencyScope: row.concurrencyScope as ApiKeyConcurrencyScope }
        : {}),
      ...(row.maxChildren === null ? {} : { maxChildren: row.maxChildren }),
      ...(row.modelPrefix === null ? {} : { modelPrefix: row.modelPrefix }),
      modelAccessMode: row.modelAccessMode,
      ...(row.modelList === null ? {} : { modelList: row.modelList as string[] }),
      ...(row.clientRouterDenylist === null
        ? {}
        : { clientRouterDenylist: row.clientRouterDenylist as string[] }),
      createdAt: row.createdAt,
      ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}),
      ...(row.bannedAt ? { bannedAt: row.bannedAt } : {}),
      ...(row.banReason ? { banReason: row.banReason } : {}),
      ...(row.bannedUntil ? { bannedUntil: row.bannedUntil } : {}),
      tokensConsumed: row.lifetimeTokensConsumed,
    };
  }
  async list(tenantId: string): Promise<readonly ApiKeyRecord[]> {
    // Bounded: a large tenant key list must not load fully into memory.
    // Ordered by the explicit `sort_index`, not `created_at`: a stable key means
    // rows keep their position across reloads (and can be reordered) instead of
    // shifting when two rows share a timestamp or one is updated.
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.tenantId, tenantId))
      // Parents first: share children all carry `sort_index = 0` (the column
      // default), so sorting by `sort_index` alone lets a huge family of
      // children crowd every top-level key except the one with the oldest
      // `created_at` out of the 1000-row page. The console only renders
      // top-level keys, so they must never be truncated away by their own
      // children.
      .orderBy(sql`(${apiKeys.parentKeyId} IS NOT NULL)`, apiKeys.sortIndex, apiKeys.createdAt, apiKeys.id)
      .limit(1000);
    return this.withPopups(this.db, rows);
  }

  /** Rewrites the list order for one tenant; `keyIds` is the full order. */
  async reorder(tenantId: string, keyIds: readonly string[]): Promise<void> {
    await reorderSortIndex(
      this.db,
      { table: apiKeys, idColumn: apiKeys.id, sortIndexColumn: apiKeys.sortIndex },
      eq(apiKeys.tenantId, tenantId),
      keyIds,
    );
  }

  /** Next free list position for a new key in this tenant. */
  private async nextSortIndex(tenantId: string): Promise<number> {
    return nextSortIndex(
      this.db,
      { table: apiKeys, idColumn: apiKeys.id, sortIndexColumn: apiKeys.sortIndex },
      eq(apiKeys.tenantId, tenantId),
    );
  }
  async get(tenantId: string, keyId: string): Promise<ApiKeyRecord | undefined> {
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.id, keyId)))
      .limit(1);
    return rows[0] ? (await this.withPopups(this.db, rows))[0] : undefined;
  }
  async listChildren(tenantId: string, parentKeyId: string): Promise<readonly ApiKeyRecord[]> {
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.tenantId, tenantId),
          eq(apiKeys.parentKeyId, parentKeyId),
        ),
      )
      .orderBy(apiKeys.createdAt, apiKeys.id);
    return this.withPopups(this.db, rows);
  }

  async listChildrenPage(
    tenantId: string,
    parentKeyId: string,
    options: SharedChildrenPageOptions,
  ): Promise<SharedChildrenPage> {
    const column = SHARED_CHILD_SORT_COLUMNS[options.sortBy];
    const direction = options.order === "desc" ? desc(column) : asc(column);
    const statusFilter =
      options.status === "active"
        ? isNull(apiKeys.revokedAt)
        : options.status === "revoked"
          ? isNotNull(apiKeys.revokedAt)
          : undefined;
    const where = and(
      eq(apiKeys.tenantId, tenantId),
      eq(apiKeys.parentKeyId, parentKeyId),
      statusFilter,
    );
    // The page query and the count query run together; the counts feed the
    // modal's header ("active users") without a second round trip per page.
    const [rows, counts, template] = await Promise.all([
      this.db.select().from(apiKeys).where(where).orderBy(direction, apiKeys.createdAt, apiKeys.id)
        .limit(options.limit)
        .offset(options.offset),
      this.db
        .select({
          total: count(),
          active: sql<number>`count(*) filter (where ${apiKeys.revokedAt} is null)`,
          revoked: sql<number>`count(*) filter (where ${apiKeys.revokedAt} is not null)`,
        })
        .from(apiKeys)
        .where(where),
      this.db
        .select({ lifetime: apiKeys.lifetimeTokensConsumed })
        .from(apiKeys)
        .where(eq(apiKeys.id, parentKeyId))
        .limit(1),
    ]);
    const summary = counts[0]!;
    // Cumulative family spend: the template's own counter plus every telemetry
    // total row the family ever recorded (revoked/deleted children stay
    // counted). Deleted children leave telemetry rows behind, so this is the
    // number that survives cleanup — matching the overview and share page.
    const familyTelemetry = await this.sumFamilyTelemetryConsumed(tenantId, parentKeyId);
    return {
      rows: await this.withPopups(this.db, rows),
      total: Number(summary.total),
      active: Number(summary.active),
      revoked: Number(summary.revoked),
      consumed: Number(template[0]?.lifetime ?? 0) + familyTelemetry,
    };
  }
  /**
   * Revokes every active child (or only the active children that never spent
   * a token) of a share template, in bounded batches so one statement never
   * exceeds the pool's statement timeout. A family can hold hundreds of
   * thousands of recipients; the console's bulk actions target all of them,
   * not just the currently rendered page.
   */
  async revokeChildrenByScope(
    tenantId: string,
    parentKeyId: string,
    scope: "active" | "unused",
  ): Promise<number> {
    const condition = and(
      eq(apiKeys.tenantId, tenantId),
      eq(apiKeys.parentKeyId, parentKeyId),
      isNull(apiKeys.revokedAt),
      ...(scope === "unused" ? [eq(apiKeys.lifetimeTokensConsumed, 0)] : []),
    );
    let deleted = 0;
    for (;;) {
      const batch = await this.db
        .select({ id: apiKeys.id })
        .from(apiKeys)
        .where(condition)
        .orderBy(apiKeys.id)
        .limit(5000);
      if (batch.length === 0) return deleted;
      const result = await this.db
        .delete(apiKeys)
        .where(inArray(apiKeys.id, batch.map((row) => row.id)));
      deleted += result.rowCount ?? batch.length;
    }
  }

  async sumFamilyTelemetryConsumed(tenantId: string, parentKeyId: string): Promise<number> {
    const rows = await this.db
      .select({
        total: sql<number>`coalesce(sum(${telemetryUsageTotals.inputTokens} + ${telemetryUsageTotals.outputTokens}), 0)`,
      })
      .from(telemetryUsageTotals)
      .where(
        and(
          eq(telemetryUsageTotals.tenantId, tenantId),
          eq(telemetryUsageTotals.identityType, "api_key"),
          sql`(${telemetryUsageTotals.familyTemplateKeyId} = ${parentKeyId} or (${telemetryUsageTotals.familyTemplateKeyId} is null and exists (select 1 from ${apiKeys} where ${apiKeys.id} = ${telemetryUsageTotals.entityId} and ${apiKeys.parentKeyId} = ${parentKeyId})))`,
        ),
      );
    return Number(rows[0]?.total ?? 0);
  }

  async create(record: ApiKeyRecord): Promise<void> {
    // Append to the end of the tenant's list rather than relying on creation
    // time, so a new key never displaces the existing rows' positions.
    const sortIndex = await this.nextSortIndex(record.tenantId);
    await this.db.insert(apiKeys).values({
      id: record.id,
      tenantId: record.tenantId,
      sortIndex,
      keyHash: record.keyHash,
      keyMode: record.keyMode,
      parentKeyId: record.parentKeyId ?? null,
      issuedClientIp: record.issuedClientIp ?? null,
      issuedClientIpKey: record.issuedClientIpKey ?? null,
      label: record.label,
      scopes: record.scopes,
      enabled: record.enabled,
      keyPrefix: record.keyPrefix ?? null,
      keyEncrypted: record.keyEncrypted ?? null,
      notesTitle: record.notesTitle ?? null,
      notesSubtitle: record.notesSubtitle ?? null,
      notesBody: record.notesBody ?? null,
      requestsPerMinute: record.requestsPerMinute ?? null,
      dailyTokenLimit: record.dailyTokenLimit ?? null,
      monthlyTokenLimit: record.monthlyTokenLimit ?? null,
      lifetimeTokenBudget: record.lifetimeTokenBudget ?? null,
      maxConcurrentRequests: record.maxConcurrentRequests ?? null,
      concurrencyScope: record.concurrencyScope ?? "family",
      maxChildren: record.maxChildren ?? null,
      modelPrefix: record.modelPrefix ?? null,
      modelAccessMode: record.modelAccessMode ?? "whitelist",
      modelList: record.modelList ?? null,
      clientRouterDenylist: record.clientRouterDenylist ?? null,
      lifetimeTokensConsumed: record.tokensConsumed,
    });
    await writeSharePopup(this.db, record.id, record);
  }
  async update(
    tenantId: string,
    keyId: string,
    patch: ApiKeyPatch,
  ): Promise<ApiKeyRecord | undefined> {
    return this.db.transaction(async (tx) => {
      const existingRows = await lockRows(
        tx
          .select({
            id: apiKeys.id,
            keyMode: apiKeys.keyMode,
            parentKeyId: apiKeys.parentKeyId,
          })
          .from(apiKeys)
          .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.id, keyId)))
          .limit(1),
      );
      const existing = existingRows[0];
      if (!existing) return undefined;
      if (existing.parentKeyId !== null && patch.keyMode !== undefined && patch.keyMode !== existing.keyMode)
        return undefined;

      if (existing.keyMode === "share" && patch.keyMode === "personal") {
        await tx
          .update(apiKeys)
          .set({ revokedAt: new Date() })
          .where(and(eq(apiKeys.parentKeyId, keyId), isNull(apiKeys.revokedAt)));
        await tx
          .update(shareLinks)
          .set({ active: false })
          .where(and(eq(shareLinks.apiKeyId, keyId), eq(shareLinks.active, true)));
      }

      const rows = await tx
        .update(apiKeys)
        .set({
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          ...(patch.label !== undefined ? { label: patch.label } : {}),
          ...(patch.isDefault !== undefined ? { isDefault: patch.isDefault } : {}),
          ...(patch.keyHash !== undefined ? { keyHash: patch.keyHash } : {}),
          ...(patch.keyMode !== undefined ? { keyMode: patch.keyMode } : {}),
          ...(patch.keyEncrypted !== undefined ? { keyEncrypted: patch.keyEncrypted } : {}),
          ...(patch.keyPrefix !== undefined ? { keyPrefix: patch.keyPrefix } : {}),
          ...(patch.notesTitle !== undefined ? { notesTitle: patch.notesTitle } : {}),
          ...(patch.notesSubtitle !== undefined ? { notesSubtitle: patch.notesSubtitle } : {}),
          ...(patch.notesBody !== undefined ? { notesBody: patch.notesBody } : {}),
          ...(patch.requestsPerMinute !== undefined
            ? { requestsPerMinute: patch.requestsPerMinute }
            : {}),
          ...(patch.dailyTokenLimit !== undefined ? { dailyTokenLimit: patch.dailyTokenLimit } : {}),
          ...(patch.monthlyTokenLimit !== undefined
            ? { monthlyTokenLimit: patch.monthlyTokenLimit }
            : {}),
          ...(patch.lifetimeTokenBudget !== undefined
            ? { lifetimeTokenBudget: patch.lifetimeTokenBudget }
            : {}),
          ...(patch.maxConcurrentRequests !== undefined
            ? { maxConcurrentRequests: patch.maxConcurrentRequests }
            : {}),
          ...(patch.concurrencyScope !== undefined
            ? { concurrencyScope: patch.concurrencyScope }
            : {}),
          ...(patch.maxChildren !== undefined ? { maxChildren: patch.maxChildren } : {}),
          ...(patch.modelPrefix !== undefined ? { modelPrefix: patch.modelPrefix } : {}),
          ...(patch.modelAccessMode !== undefined ? { modelAccessMode: patch.modelAccessMode } : {}),
          ...(patch.modelList !== undefined ? { modelList: patch.modelList } : {}),
          ...(patch.clientRouterDenylist !== undefined
            ? { clientRouterDenylist: patch.clientRouterDenylist }
            : {}),
          // Scopes are validated once, in `validateApiKeyRequest`, against the
          // tenant scope set; the store writes what it is handed. Omitting the
          // field here means an update is type-checked, accepted, and then
          // silently dropped — a grant like `routing:cli_mapping` can be
          // turned on and never stick.
          ...(patch.scopes === undefined ? {} : { scopes: patch.scopes }),
          ...(patch.bannedAt !== undefined ? { bannedAt: patch.bannedAt } : {}),
          ...(patch.banReason !== undefined ? { banReason: patch.banReason } : {}),
        })
        .where(and(eq(apiKeys.tenantId, tenantId), eq(apiKeys.id, keyId)))
        .returning();
      if (!rows[0]) return undefined;
      if (popupPatchTouched(patch)) await mergeSharePopup(tx, keyId, patch);
      return (await this.withPopups(tx, rows))[0];
    });
  }
  async revoke(tenantId: string, keyId: string, revokedAt: Date): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .update(apiKeys)
        .set({ revokedAt })
        .where(
          and(
            eq(apiKeys.tenantId, tenantId),
            eq(apiKeys.id, keyId),
            isNull(apiKeys.revokedAt),
          ),
        )
        .returning({ id: apiKeys.id, keyMode: apiKeys.keyMode, parentKeyId: apiKeys.parentKeyId });
      const row = rows[0];
      if (!row) return false;
      if (row.keyMode === "share" && row.parentKeyId === null) {
        await tx
          .update(apiKeys)
          .set({ revokedAt })
          .where(and(eq(apiKeys.parentKeyId, keyId), isNull(apiKeys.revokedAt)));
        await tx
          .update(shareLinks)
          .set({ active: false })
          .where(and(eq(shareLinks.apiKeyId, keyId), eq(shareLinks.active, true)));
      }
      return true;
    });
  }

  async ban(
    tenantId: string,
    keyId: string,
    reason: string,
    bannedUntil?: Date | null,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .update(apiKeys)
        .set({
          bannedAt: new Date(),
          banReason: reason,
          // `banned_until` null = permanent. The key stays `enabled` as-is:
          // the auth path refuses a banned key while `banned_at` is set and
          // `banned_until` is null or future, so a timed ban lapses on its own
          // without a sweep flipping `enabled` back.
          ...(bannedUntil === undefined ? {} : { bannedUntil }),
        })
        .where(
          and(
            eq(apiKeys.tenantId, tenantId),
            eq(apiKeys.id, keyId),
            isNull(apiKeys.revokedAt),
          ),
        )
        .returning({ id: apiKeys.id });
      return rows.length > 0;
    });
  }

  async unban(tenantId: string, keyId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      // Unban clears all three ban columns entirely — no tombstone, no leftover
      // reason, no stale expiry. The key returns to its prior enabled state.
      const rows = await tx
        .update(apiKeys)
        .set({ bannedAt: null, banReason: null, bannedUntil: null, enabled: true })
        .where(
          and(
            eq(apiKeys.tenantId, tenantId),
            eq(apiKeys.id, keyId),
            isNull(apiKeys.revokedAt),
          ),
        )
        .returning({ id: apiKeys.id });
      return rows.length > 0;
    });
  }
  async remove(tenantId: string, keyId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .delete(apiKeys)
        .where(
          and(
            eq(apiKeys.tenantId, tenantId),
            eq(apiKeys.id, keyId),
            eq(apiKeys.isDefault, false),
          ),
        )
        .returning({ id: apiKeys.id });
      return rows.length > 0;
    });
  }
  async findActiveByHash(hash: string): Promise<typeof apiKeys.$inferSelect | undefined> {
    // The SQLite backend holds this lookup prepared. The builder path rebuilds
    // the query per call, which measured 60x the lookup itself, so the hot
    // path skips it. PostgreSQL has no prepared statement here and uses the
    // builder, whose plan is cached server-side.
    const prepared = getDbHandle().auth;
    if (prepared) return this.authRow(prepared.byHash.get(hash));
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, hash), eq(apiKeys.enabled, true), isNull(apiKeys.revokedAt), notBannedSql()))
      .limit(1);
    return rows[0];
  }

  async findActiveById(keyId: string): Promise<typeof apiKeys.$inferSelect | undefined> {
    const prepared = getDbHandle().auth;
    if (prepared) return this.authRow(prepared.byId.get(keyId));
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.enabled, true), isNull(apiKeys.revokedAt), notBannedSql()))
      .limit(1);
    return rows[0];
  }

  /**
   * Maps a raw SQLite auth row to the shape drizzle returns.
   *
   * The prepared statement selects the table's own column names, which are
   * snake_case, while every reader of this row — `resolveApiKeyAuthorization`
   * included — reads the camelCase `$inferSelect` fields. Copying the raw
   * keys and casting would typecheck and then hand auth `undefined` for
   * `parentKeyId`, `tenantId`, and every limit. SQLite also stores JSON as
   * text and booleans as integers, so those are converted here too. The SQL
   * stays a plain select.
   */
  private authRow(raw: Record<string, unknown> | null): typeof apiKeys.$inferSelect | undefined {
    if (raw === null) return undefined;
    const text = (key: string): string | null => {
      const value = raw[key];
      return typeof value === "string" ? value : null;
    };
    const date = (key: string): Date | null => {
      const value = text(key);
      return value === null ? null : new Date(value);
    };
    const integer = (key: string): number | null => {
      const value = raw[key];
      return typeof value === "number" ? value : null;
    };
    const json = (key: string): unknown => {
      const value = raw[key];
      return typeof value === "string" ? JSON.parse(value) : (value ?? null);
    };
    const flag = (key: string): boolean => raw[key] === 1 || raw[key] === true;
    return {
      id: text("id") ?? "",
      tenantId: text("tenant_id") ?? "",
      keyHash: text("key_hash"),
      keyMode: (text("key_mode") ?? "personal") as ApiKeyMode,
      parentKeyId: text("parent_key_id"),
      issuedClientIp: text("issued_client_ip"),
      issuedClientIpKey: text("issued_client_ip_key"),
      label: text("label") ?? "",
      scopes: json("scopes"),
      requestsPerMinute: integer("requests_per_minute"),
      dailyTokenLimit: integer("daily_token_limit"),
      monthlyTokenLimit: integer("monthly_token_limit"),
      lifetimeTokenBudget: integer("lifetime_token_budget"),
      lifetimeTokensConsumed: integer("lifetime_tokens_consumed") ?? 0,
      maxConcurrentRequests: integer("max_concurrent_requests"),
      concurrencyScope: (text("concurrency_scope") ?? "family") as ApiKeyConcurrencyScope,
      modelAccessMode: (text("model_access_mode") ?? "whitelist") as ApiKeyModelAccessMode,
      modelList: json("model_list"),
      clientRouterDenylist: json("client_router_denylist"),
      modelPrefix: text("model_prefix"),
      createdAt: date("created_at") ?? new Date(0),
      enabled: flag("enabled"),
      revokedAt: date("revoked_at"),
      bannedAt: date("banned_at"),
      banReason: text("ban_reason"),
      bannedUntil: date("banned_until"),
      keyPrefix: text("key_prefix"),
      keyEncrypted: raw["key_encrypted"] ?? null,
      notesTitle: text("notes_title"),
      notesSubtitle: text("notes_subtitle"),
      notesBody: text("notes_body"),
      isDefault: flag("is_default"),
      sortIndex: integer("sort_index") ?? 0,
    } as unknown as typeof apiKeys.$inferSelect;
  }

  /**
   * Total lifetime consumption across one key's children, revoked included.
   *
   * The parent's own counter never moves for child traffic — attribution
   * lands on the child row — so quota enforcement reads the parent plus this
   * sum rather than the parent alone.
   *
   * Revoked children stay in the sum on purpose. Tokens a recipient already
   * spent are spent; dropping them on revoke would refund the parent's budget
   * the moment the Redis lifetime counter is re-seeded from this total (which
   * happens on every purge, and whenever that counter's TTL lapses), letting a
   * recipient burn the whole allowance, be revoked, and hand the next
   * recipient a fresh one. It also keeps this figure equal to the "Total
   * quota" the share dialog reports, which counts every recipient.
   */
  async sumChildrenConsumed(parentKeyId: string): Promise<number> {
    const prepared = getDbHandle().auth;
    if (prepared) return Number(prepared.childrenConsumed.get(parentKeyId)?.total ?? 0);
    const rows = await this.db
      .select({ total: sql<number>`coalesce(sum(${apiKeys.lifetimeTokensConsumed}), 0)` })
      .from(apiKeys)
      .where(eq(apiKeys.parentKeyId, parentKeyId));
    return Number(rows[0]?.total ?? 0);
  }
}
