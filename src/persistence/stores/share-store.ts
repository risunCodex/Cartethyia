import { createHash, randomBytes, randomInt } from "node:crypto";

// Share-link persistence and atomic child-key issuance. The hash is the lookup
// key; the bearer token is retained encrypted so the console can re-display a
// stable link, and is never selected by a public lookup.

import { and, desc, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import type { CartethyiaDatabase } from "../db-handle";
import { lockRows } from "../dialect";
import { apiKeys, shareLinks, sharePopups, type ShareLinkKind, type ApiKeyModelAccessMode, type ApiKeyConcurrencyScope } from "../schema";

/** Hashes a share bearer token for storage and lookup. */
/**
 * A fresh public slug for a share page.
 *
 * Held in the clear and looked up by index, so it must be unguessable on its
 * own: the same 256 bits of entropy as the bearer token, base64url-encoded.
 */
export function generateShareSlug(): string {
  return randomBytes(32).toString("base64url");
}

export function hashShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * The predicate matching one link's two public address forms.
 *
 * `slug` is held in the clear — that is what lets a restore onto a fresh
 * deployment keep every address — while the bearer token is only ever stored
 * as `hashShareToken(token)`. So the two columns cannot be compared against
 * one value: a lookup built from a hash alone silently never matches the slug
 * column, which is how a freshly generated link answered "not found".
 */
function addressMatches(address: string): SQL {
  return or(eq(shareLinks.slug, address), eq(shareLinks.tokenHash, hashShareToken(address)))!;
}

/** Newly created share-link metadata. */
interface ShareLinkRecord {
  readonly id: string;
  readonly apiKeyId: string;
  readonly kind: ShareLinkKind;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
}

/**
 * Console-facing view of one link. The caller supplies the decrypted token;
 * this record itself never reads the token column.
 */
export interface ShareLinkSummary {
  readonly id: string;
  readonly apiKeyId: string;
  readonly kind: ShareLinkKind;
  readonly active: boolean;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly lastViewedAt: Date | null;
}

/** A stable link's encrypted token, or null when it predates token retention. */
interface ShareLinkToken {
  readonly id: string;
  readonly apiKeyId: string;
  readonly kind: ShareLinkKind;
  readonly expiresAt: Date | null;
  readonly tokenEncrypted: Buffer | null;
  /** Public address fragment, held in the clear; null on pre-migration rows. */
  readonly slug: string | null;
}

/**
 * Policy fields a share recipient sees, whichever kind of link carried them.
 * Both resolutions project the same columns, so the public payload and the
 * model filter read one shape instead of two near-identical ones.
 */
export interface ShareLinkPolicy {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly keyPrefix: string | null;
  readonly requestsPerMinute: number | null;
  readonly dailyTokenLimit: number | null;
  readonly monthlyTokenLimit: number | null;
  readonly lifetimeTokenBudget: number | null;
  readonly maxConcurrentRequests: number | null;
  readonly concurrencyScope: ApiKeyConcurrencyScope;
  readonly modelAccessMode: ApiKeyModelAccessMode | null;
  readonly modelList: readonly string[] | null;
  readonly modelPrefix: string | null;
  readonly notesTitle: string | null;
  readonly notesSubtitle: string | null;
  readonly notesBody: string | null;
  readonly sharePopupEnabled: boolean;
  /** Uploaded popup art; the share page fetches it from its own image route. */
  readonly sharePopupImage: Buffer | null;
  readonly sharePopupImageMime: string | null;
  readonly sharePopupTitle: string | null;
  readonly sharePopupBody: string | null;
  readonly expiresAt: string | null;
}

/** Public template fields authorized for a valid enrollment-link lookup. */
interface ShareApiKeyRow extends ShareLinkPolicy {
  readonly active: boolean;
  readonly createdAt: string;
}

/** A personal key revealed by its handoff link. */
interface ShareHandoffRow extends ShareLinkPolicy {
  /** Encrypted personal credential; null when the row predates secret storage. */
  readonly keyEncrypted: Buffer | null;
}

/**
 * What one bearer token resolves to. A link is exactly one of these, so a
 * public lookup answers with a discriminated result instead of the caller
 * guessing which endpoint to try.
 */
type ShareLinkResolution =
  | { readonly kind: "enroll"; readonly key: ShareApiKeyRow }
  | { readonly kind: "handoff"; readonly key: ShareHandoffRow };

/**
 * Why a share link stopped resolving.
 *
 * A paused key (`disabled`) is not a revoked one and not an expired link, but
 * the resolver answered `null` for all three, so the page could only say
 * "link unavailable" — which tells an operator nothing about whether to
 * regenerate the link, re-enable the key, or issue a new one.
 */
export type ShareLinkRefusal = "not_found" | "expired" | "revoked" | "disabled";

export type ShareLinkOutcome =
  | { readonly ok: true; readonly resolution: ShareLinkResolution }
  | { readonly ok: false; readonly refusal: ShareLinkRefusal };

interface SharedApiKeyMaterial {
  readonly keyHash: string;
  readonly keyPrefix: string;
  readonly clientIp: string;
  readonly clientIpKey: string;
  /** Recipient-supplied name hint; the store composes the final label from it. */
  readonly nameHint?: string;
}

type SharedApiKeyIssueResult =
  | {
      readonly kind: "issued";
      readonly apiKeyId: string;
      readonly parentKeyId: string;
      readonly tenantId: string;
      readonly label: string;
      readonly keyPrefix: string;
      readonly createdAt: Date;
    }
  | { readonly kind: "link_unavailable" }
  | {
      readonly kind: "already_issued";
      readonly parentKeyId: string;
      readonly tenantId: string;
    }
  | {
      readonly kind: "slot_full";
      readonly parentKeyId: string;
      readonly tenantId: string;
      readonly limit: number;
    };

type ApiKeyRow = typeof apiKeys.$inferSelect;
type ShareLinkRow = typeof shareLinks.$inferSelect;

type PopupRow = typeof sharePopups.$inferSelect;

function mapShareRow(key: ApiKeyRow, link: ShareLinkRow, popup?: PopupRow): ShareApiKeyRow {
  return {
    id: key.id,
    tenantId: key.tenantId,
    name: key.label,
    keyPrefix: key.keyPrefix,
    active: key.revokedAt === null,
    requestsPerMinute: key.requestsPerMinute,
    dailyTokenLimit: key.dailyTokenLimit,
    monthlyTokenLimit: key.monthlyTokenLimit,
    lifetimeTokenBudget: key.lifetimeTokenBudget,
    maxConcurrentRequests: key.maxConcurrentRequests,
    concurrencyScope: key.concurrencyScope ?? "family",
    modelAccessMode: key.modelAccessMode as ApiKeyModelAccessMode | null,
    modelList: key.modelList as readonly string[] | null,
    modelPrefix: key.modelPrefix,
    notesTitle: key.notesTitle,
    notesSubtitle: key.notesSubtitle,
    notesBody: key.notesBody,
    sharePopupEnabled: popup?.enabled ?? false,
    sharePopupImage: popup?.image ?? null,
    sharePopupImageMime: popup?.imageMime ?? null,
    sharePopupTitle: popup?.title ?? null,
    sharePopupBody: popup?.body ?? null,
    createdAt: key.createdAt.toISOString(),
    expiresAt: link.expiresAt?.toISOString() ?? null,
  };
}

function mapHandoffRow(key: ApiKeyRow, link: ShareLinkRow, popup?: PopupRow): ShareHandoffRow {
  return {
    id: key.id,
    tenantId: key.tenantId,
    name: key.label,
    keyPrefix: key.keyPrefix,
    keyEncrypted: key.keyEncrypted,
    requestsPerMinute: key.requestsPerMinute,
    dailyTokenLimit: key.dailyTokenLimit,
    monthlyTokenLimit: key.monthlyTokenLimit,
    lifetimeTokenBudget: key.lifetimeTokenBudget,
    maxConcurrentRequests: key.maxConcurrentRequests,
    concurrencyScope: key.concurrencyScope ?? "family",
    modelAccessMode: key.modelAccessMode as ApiKeyModelAccessMode | null,
    modelList: key.modelList as readonly string[] | null,
    modelPrefix: key.modelPrefix,
    notesTitle: key.notesTitle,
    notesSubtitle: key.notesSubtitle,
    notesBody: key.notesBody,
    sharePopupEnabled: popup?.enabled ?? false,
    sharePopupImage: popup?.image ?? null,
    sharePopupImageMime: popup?.imageMime ?? null,
    sharePopupTitle: popup?.title ?? null,
    sharePopupBody: popup?.body ?? null,
    expiresAt: link.expiresAt?.toISOString() ?? null,
  };
}

/** Persistence boundary for public enrollment links and child API keys. */
export interface ShareLinkStore {
  /**
   * Establishes the key's single link, or rotates it in place.
   *
   * One active link per key is the contract: calling this again replaces the
   * token so the previous URL stops resolving. `rotate` false returns the
   * existing link untouched.
   */
  create(input: {
    apiKeyId: string;
    tokenHash: string;
    tokenEncrypted: Buffer;
    /** Public address fragment; kept across rotates so the URL is stable. */
    slug: string;
    kind: ShareLinkKind;
    expiresAt: Date | null;
    rotate: boolean;
  }): Promise<ShareLinkRecord>;
  /**
   * Resolves a link's public address to the link it names, in one lookup.
   *
   * The argument is the raw path segment — a slug or a bearer token — not a
   * hash: the store owns hashing, so a caller cannot hand it a slug-shaped
   * value that only matches the hashed column.
   *
   * Serving enrollment and handoff through separate methods let the browser
   * page and the router disagree about which one a given URL is: a personal
   * key's handoff link resolved on one endpoint and 404'd on the other. One
   * resolver cannot drift from itself.
   */
  resolveShareLink(address: string): Promise<ShareLinkResolution | null>;
  /** Same lookup as `resolveShareLink`, but names why a link stopped resolving. */
  resolveShareLinkOutcome(address: string): Promise<ShareLinkOutcome>;
  /** The key's active link with its retained token, for console re-display. */
  findTokenForApiKey(apiKeyId: string): Promise<ShareLinkToken | null>;
  /**
   * Mints one child key under the link named by `address`.
   *
   * `address` is the raw path segment, so a slug-addressed link issues
   * exactly like a token-addressed one.
   */
  issueSharedApiKey(
    address: string,
    material: SharedApiKeyMaterial,
  ): Promise<SharedApiKeyIssueResult>;
  /** Records a view of the link named by `address` (slug or bearer token). */
  touchView(address: string): Promise<void>;
  /** All enrollment links for one API key, newest first (never tokens). */
  listForApiKey(apiKeyId: string): Promise<readonly ShareLinkSummary[]>;
  /** Deactivates one enrollment link scoped to its owning parent API key. */
  revoke(apiKeyId: string, shareId: string): Promise<boolean>;
}

export class DrizzleShareLinkStore implements ShareLinkStore {
  constructor(private readonly db: CartethyiaDatabase) {}

  async create(input: {
    apiKeyId: string;
    tokenHash: string;
    tokenEncrypted: Buffer;
    slug: string;
    kind: ShareLinkKind;
    expiresAt: Date | null;
    rotate: boolean;
  }): Promise<ShareLinkRecord> {
    return await this.db.transaction(async (tx) => {
      const existing = await lockRows(
        tx
          .select()
          .from(shareLinks)
          .where(and(eq(shareLinks.apiKeyId, input.apiKeyId), eq(shareLinks.active, true)))
          .orderBy(desc(shareLinks.createdAt))
          .limit(1),
      );
      const current = existing[0];
      if (current && !input.rotate) {
        return {
          id: current.id,
          apiKeyId: current.apiKeyId,
          kind: current.kind,
          createdAt: current.createdAt,
          expiresAt: current.expiresAt,
        };
      }
      if (current) {
        const updated = await tx
          .update(shareLinks)
          .set({
            tokenHash: input.tokenHash,
            tokenEncrypted: input.tokenEncrypted,
            // Rotating the slug changes the public URL, so the old link stops resolving.
            // Callers always generate a fresh slug via generateShareSlug() before calling
            // create() with rotate: true.
            slug: input.slug,
            expiresAt: input.expiresAt,
            lastViewedAt: null,
          })
          .where(eq(shareLinks.id, current.id))
          .returning();
        const row = updated[0];
        if (!row) throw new Error("share link rotate returned no row");
        return {
          id: row.id,
          apiKeyId: row.apiKeyId,
          kind: row.kind,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
        };
      }
      const rows = await tx
        .insert(shareLinks)
        .values({
          apiKeyId: input.apiKeyId,
          tokenHash: input.tokenHash,
          tokenEncrypted: input.tokenEncrypted,
          slug: input.slug,
          kind: input.kind,
          expiresAt: input.expiresAt,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error("share link insert returned no row");
      return {
        id: row.id,
        apiKeyId: row.apiKeyId,
        kind: row.kind,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      };
    });
  }

  async resolveShareLink(address: string): Promise<ShareLinkResolution | null> {
    const outcome = await this.resolveShareLinkOutcome(address);
    return outcome.ok ? outcome.resolution : null;
  }

  /**
   * Same lookup as {@link resolveShareLink}, but reports *why* a link stopped
   * resolving instead of collapsing every cause into `null`. The refusal is
   * decided from the row that actually exists: dropping the health predicates
   * from the `WHERE` and classifying afterwards is the only way to tell an
   * expired link from a revoked key from a paused one, since a row failing any
   * of them is simply absent from the filtered result.
   */
  async resolveShareLinkOutcome(address: string): Promise<ShareLinkOutcome> {
    // Two address forms name one link: the public slug, and the bearer token
    // a pre-slug page was issued with. They are matched in their own form —
    // the slug is stored in the clear (that is how a restored deployment keeps
    // its addresses), while the token is only ever stored as a hash. Comparing
    // the slug against a hash can never match, which made every slug-addressed
    // link answer "not found" for a page that had just been generated.
    const rows = await this.db
      .select({ key: apiKeys, link: shareLinks, popup: sharePopups })
      .from(shareLinks)
      .innerJoin(apiKeys, eq(shareLinks.apiKeyId, apiKeys.id))
      .leftJoin(sharePopups, eq(sharePopups.apiKeyId, apiKeys.id))
      .where(
        and(
          addressMatches(address),
          isNull(apiKeys.parentKeyId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) return { ok: false, refusal: "not_found" };
    // Ordering: a deactivated link was revoked by its owner, not expired —
    // "expired" would send them to regenerate a link they deliberately killed.
    // Beyond that, report the state the operator can actually change: a key
    // can be both paused and expired, and either way the link needs
    // regenerating, so the key's own state is the more actionable answer.
    if (row.link.active !== true) return { ok: false, refusal: "revoked" };
    if (row.key.revokedAt !== null) return { ok: false, refusal: "revoked" };
    if (row.key.enabled !== true) return { ok: false, refusal: "disabled" };
    if (row.link.expiresAt !== null && row.link.expiresAt.getTime() <= Date.now())
      return { ok: false, refusal: "expired" };
    // The link's kind and the key's mode must agree: an enrollment link hands
    // out child keys from a share template, which has no credential of its own
    // to reveal, while a handoff link reveals a personal key. A row where the
    // two disagree is a mismatched pair, not a link to serve.
    if (row.link.kind === "enroll") {
      return row.key.keyMode === "share"
        ? { ok: true, resolution: { kind: "enroll", key: mapShareRow(row.key, row.link, row.popup ?? undefined) } }
        : { ok: false, refusal: "not_found" };
    }
    return row.key.keyMode === "personal"
      ? { ok: true, resolution: { kind: "handoff", key: mapHandoffRow(row.key, row.link, row.popup ?? undefined) } }
      : { ok: false, refusal: "not_found" };
  }

  async findTokenForApiKey(apiKeyId: string): Promise<ShareLinkToken | null> {
    const rows = await this.db
      .select({
        id: shareLinks.id,
        apiKeyId: shareLinks.apiKeyId,
        kind: shareLinks.kind,
        expiresAt: shareLinks.expiresAt,
        tokenEncrypted: shareLinks.tokenEncrypted,
        slug: shareLinks.slug,
      })
      .from(shareLinks)
      .where(
        and(
          eq(shareLinks.apiKeyId, apiKeyId),
          eq(shareLinks.active, true),
          sql`(${shareLinks.expiresAt} IS NULL OR ${shareLinks.expiresAt} > now())`,
        ),
      )
      .orderBy(desc(shareLinks.createdAt))
      .limit(1);
    return rows[0] ?? null;
  }

  async issueSharedApiKey(
    address: string,
    material: SharedApiKeyMaterial,
  ): Promise<SharedApiKeyIssueResult> {
    return this.db.transaction(async (tx) => {
      // Read the link first without locking, then lock its parent before the
      // link. Parent revocation uses the same lock order and is atomic with
      // child revocation, so a concurrent issue cannot escape the parent.
      const [linkRef] = await tx
        .select({ id: shareLinks.id, apiKeyId: shareLinks.apiKeyId })
        .from(shareLinks)
        .where(
          and(
            addressMatches(address),
            eq(shareLinks.kind, "enroll"),
            eq(shareLinks.active, true),
            sql`(${shareLinks.expiresAt} IS NULL OR ${shareLinks.expiresAt} > now())`,
          ),
        )
        .limit(1);
      if (!linkRef) return { kind: "link_unavailable" };

      const [parent] = await lockRows(
        tx
          .select()
          .from(apiKeys)
          .where(
            and(
              eq(apiKeys.id, linkRef.apiKeyId),
              eq(apiKeys.keyMode, "share"),
              isNull(apiKeys.parentKeyId),
              isNull(apiKeys.revokedAt),
            ),
          )
          .limit(1),
      );
      if (!parent) return { kind: "link_unavailable" };

      const [activeLink] = await lockRows(
        tx
          .select({ id: shareLinks.id })
          .from(shareLinks)
          .where(
            and(
              eq(shareLinks.id, linkRef.id),
              addressMatches(address),
              eq(shareLinks.active, true),
              sql`(${shareLinks.expiresAt} IS NULL OR ${shareLinks.expiresAt} > now())`,
            ),
          )
          .limit(1),
      );
      if (!activeLink) return { kind: "link_unavailable" };

      // One child key per canonical client IP. The public route mints from an
      // enrollment link, and a bot replaying the same URL from one IP was
      // creating an unbounded number of children (observed: 331k `api_keys`
      // rows from two Google Cloud IPs in three days). If this (parent, IP)
      // pair already has a live child, that is the same enrollment — return it
      // as `already_issued` instead of minting another.
      if (material.clientIpKey.length > 0) {
        const existing = await tx
          .select({ id: apiKeys.id })
          .from(apiKeys)
          .where(
            and(
              eq(apiKeys.parentKeyId, parent.id),
              eq(apiKeys.issuedClientIpKey, material.clientIpKey),
              isNull(apiKeys.revokedAt),
            ),
          )
          .limit(1);
        if (existing[0] !== undefined) {
          return {
            kind: "already_issued",
            parentKeyId: parent.id,
            tenantId: parent.tenantId,
          };
        }
      }

      // Slot cap: a template may bound how many concurrently-active children
      // exist. The public link is mint-able by anyone, so without this cap a
      // bot rotating egress IPs (CDN edges, cloud egress, proxies) could mint
      // without bound — observed: 331k children in three days. The count is
      // live children only; revoked children free their slot for reuse.
      if (parent.maxChildren !== null && parent.maxChildren !== undefined) {
        const liveCount = await tx
          .select({ value: sql<number>`count(*) filter (where ${apiKeys.revokedAt} is null)` })
          .from(apiKeys)
          .where(eq(apiKeys.parentKeyId, parent.id));
        if (Number(liveCount[0]?.value ?? 0) >= parent.maxChildren) {
          return {
            kind: "slot_full",
            parentKeyId: parent.id,
            tenantId: parent.tenantId,
            limit: parent.maxChildren,
          };
        }
      }

      // The label is `hint + random`, capped at 12 chars — never the
      // parent's full label plus a suffix, which grew past every table
      // column it rendered in. Built here (not imported from the console
      // domain) because persistence never imports console code.
      const hint = (material.nameHint ?? "").trim().slice(0, 7);
      const suffix = randomInt(1000, 10_000).toString();
      const label =
        hint.length === 0 ? `key-${suffix}` : `${hint}-${suffix}`.slice(0, 12);
      // Child rows carry identity + scopes only. Auth resolves every policy
      // field from the parent (`policy = parent ?? row`), so copying notes,
      // limits, model_list, denylist, etc. was pure write-amplification.
      // Nullable policy columns stay NULL; `model_access_mode` takes its
      // NOT NULL default ('whitelist'). Keep in sync with migration 0029 and
      // `normalizeShareChildPolicy` in `src/console/backup/store.ts`.
      //
      // Exception: a template with `concurrencyScope: "per_key"` lets each
      // recipient carry its own concurrency cap, so the cap is copied to the
      // child at issue (the child's admission identity is its own id, not the
      // parent's). The `family` default keeps child caps NULL — they inherit
      // the parent's cap through auth.
      const [child] = await tx
        .insert(apiKeys)
        .values({
          tenantId: parent.tenantId,
          keyHash: material.keyHash,
          keyMode: "share",
          parentKeyId: parent.id,
          issuedClientIp: material.clientIp,
          issuedClientIpKey: material.clientIpKey,
          label,
          scopes: parent.scopes,
          keyPrefix: material.keyPrefix,
          keyEncrypted: null,
          lifetimeTokensConsumed: 0,
          ...(parent.concurrencyScope === "per_key"
            ? { concurrencyScope: "per_key" as const, maxConcurrentRequests: parent.maxConcurrentRequests }
            : {}),
        })
        .returning({ id: apiKeys.id, tenantId: apiKeys.tenantId, createdAt: apiKeys.createdAt });
      if (!child) throw new Error("shared API-key insert returned no row");
      return {
        kind: "issued",
        apiKeyId: child.id,
        parentKeyId: parent.id,
        tenantId: child.tenantId,
        label,
        keyPrefix: material.keyPrefix,
        createdAt: child.createdAt,
      };
    });
  }

  async touchView(address: string): Promise<void> {
    // Expired-but-active links must not bump lastViewedAt: the bump makes
    // expiry auditing lie about a link that no longer serves.
    await this.db
      .update(shareLinks)
      .set({ lastViewedAt: new Date() })
      .where(
        and(
          addressMatches(address),
          eq(shareLinks.active, true),
          sql`${shareLinks.expiresAt} IS NULL OR ${shareLinks.expiresAt} > NOW()`,
        ),
      );
  }

  async listForApiKey(apiKeyId: string): Promise<readonly ShareLinkSummary[]> {
    const rows = await this.db
      .select()
      .from(shareLinks)
      .where(and(eq(shareLinks.apiKeyId, apiKeyId), eq(shareLinks.kind, "enroll")))
      .orderBy(desc(shareLinks.createdAt));
    return rows.map((row) => ({
      id: row.id,
      apiKeyId: row.apiKeyId,
      kind: "enroll",
      active: row.active,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      lastViewedAt: row.lastViewedAt,
    }));
  }

  async revoke(apiKeyId: string, shareId: string): Promise<boolean> {
    const rows = await this.db
      .update(shareLinks)
      .set({ active: false })
      .where(
        and(
          eq(shareLinks.id, shareId),
          eq(shareLinks.apiKeyId, apiKeyId),
          eq(shareLinks.kind, "enroll"),
          eq(shareLinks.active, true),
        ),
      )
      .returning({ id: shareLinks.id });
    return rows.length > 0;
  }
}
