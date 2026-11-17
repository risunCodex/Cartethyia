/**
 * Provider/account/pool catalog tables: providers, provider_accounts (+ OAuth
 * state), models, tenant-disabled models, network pools, pool accounts, and
 * the shared health-events ledger.
 */
import { desc, sql } from "drizzle-orm";
import {
  bigint, boolean, check, index, integer, jsonb, pgEnum, pgTable,
  text, timestamp, unique, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";
import type { ProviderQuotaResult } from "../providers/quota/quota-contracts";
import {
  bytea, createdAtColumn, healthColumns, healthStatus,
  tenantRefNullable, tenantRefRequired,
} from "./schema-shared";

/**
 * The persisted copy of one account's last successful quota read.
 *
 * Survives process restarts, which the in-process quota cache does not — so a
 * cold page open can render the last known balance immediately while the sweep
 * refreshes it. Stored only on success; a failed fetch leaves the previous
 * snapshot in place.
 */
export interface ProviderQuotaResultSnapshot {
  readonly quota: ProviderQuotaResult;
  readonly fetchedAt: string;
}

export const credentialKind = pgEnum("credential_kind", ["api_key", "oauth", "none"]);

// Shared wire-family domain used by providers.wire_family_default and
// models.wire_family.
//
// `gemini` is Factory's native generateContent wire. Added by forward
// migration `0002_add_gemini_wire_family.sql`; the enum here must stay in
// step with what that migration applies, or a fresh database (built from the
// baseline) and a migrated one would disagree.
export const wireFamily = pgEnum("wire_family", ["chat", "responses", "messages", "gemini"]);

// `https` is a hosted relay front door (Vercel, Cloudflare, Deno, Netlify):
// plain HTTP CONNECT to an origin that terminates TLS itself, so the transport
// is recorded as what it speaks rather than as a generic proxy.
export const networkPoolKind = pgEnum("network_pool_kind", ["http", "https", "socks5"]);

//  health_events.entity_kind — distinguishes which owning
// table entity_id/account_id/network_pool_id references.
export const healthEntityKind = pgEnum("health_entity_kind", ["account", "pool"]);

// The id matches the seven canonical builtin IDs (openai, anthropic, claude,
// codex, opencode-zen, ollamacloud, cerebras) or a custom/BYOK slug
// rejected at the identity boundary when it collides case-insensitively with
// a reserved ID — that rejection is application-layer, not a DB constraint
// here. `capability_profile` is a JSONB routing-capability map with no index:
// it is read with the provider row the snapshot builder already loads, so a
// separate index would only add write cost. `tenant_id`
// null means the provider is global/built-in, matching the same convention
// as `provider_accounts.tenant_id`; populated means tenant-owned/BYOK.
// `base_url`/`compatibility_profile` are BYOK-only: `compatibility_profile`
// carries HTTP dispatch config (extra headers/query params/streaming mode)
// and is intentionally a separate column from `capability_profile`, which
// drives routing capability flags — conflating the two would corrupt routing
// data with unrelated HTTP config.
export const providers = pgTable(
  "providers",
  {
    id: text("id").primaryKey(),
    tenantId: tenantRefNullable(),
    wireFamilyDefault: wireFamily("wire_family_default"),
    capabilityProfile: jsonb("capability_profile"),
    baseUrl: text("base_url"),
    compatibilityProfile: jsonb("compatibility_profile"),
    enabled: boolean("enabled").notNull().default(true),
    // Builtin default `true` (most providers need a real credential). Only a
    // genuinely public/unauthenticated builtin (OpenCode Free) is seeded
    // `false`. When `false`, the snapshot builder emits a routable candidate
    // with zero `provider_accounts` rows instead of marking it `disabled` —
    // see `src/transport/routing/route-catalog.ts`.
    requiresAccount: boolean("requires_account").notNull().default(true),
  },
  (table) => [
    // `globalOrOwnedBy(providers.tenantId, …)` is the predicate behind
    // `listModelsForTenant` and `/quota/overview`, and it is a bare
    // `tenant_id IS NULL OR tenant_id = ?` — which no other index here can
    // serve, so both reads scanned the whole provider list. Cheap to keep:
    // providers are few and written rarely.
    index("providers_tenant_id_idx").on(table.tenantId),
  ],
);

// Upstream account credentials plus the full health state machine.
// `tenant_id` null means the account is shared pool-wide; populated means
// tenant-owned/BYOK. The concurrency ceiling lives in provider routing
// (`provider_routing_settings.max_inflight`) and network pools
// (`network_pools.max_inflight`); there is no per-account override.
/**
 * A Qoder native machine identity (UMID) bound to one account.
 *
 * The device identity is a deterministic function of a seed file
 * (`~/.config/.locale_cfg`): the `runtime-info` bridge reads that seed and
 * derives `machineToken`/`machineType`/`machineCode`. The daily 100-credit
 * campaign does not gate grants on this identity. A persisted seed allows the
 * vendor bridge to replay the same native identity where another Qoder surface
 * requires it.
 *
 * `seed` is the exact seed-file content the identity was minted from, stored
 * so the same device identity can be replayed (restore seed → bridge → same
 * token). It is not a credential, but it is per-account device material and
 * should not be shared between accounts. Campaign grant eligibility is
 * independent of `machineToken`.
 */
export interface NativeIdentityRecord {
  readonly machineToken: string;
  readonly machineType: string;
  readonly machineCode: string;
  /** The seed-file content this identity was minted from, if captured. */
  readonly seed?: string;
  /** How this identity was produced: the genuine SG bridge, the OS fingerprint, or the fallback. */
  readonly source?: "runtime-info" | "generated" | "os";
}

export const providerAccounts = pgTable("provider_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerId: text("provider_id")
    .notNull()
    .references(() => providers.id, { onDelete: "cascade" }),
  tenantId: tenantRefNullable(),
  label: text("label").notNull(),
  credentialCiphertext: bytea("credential_ciphertext"),
  /**
   * HMAC fingerprint of the credential, never the plaintext secret. Nullable
   * for credential-less accounts and legacy rows without an identity.
   */
  credentialFingerprint: text("credential_fingerprint"),
  credentialKind: credentialKind("credential_kind").notNull(),
  /**
   * Per-account upstream auth configuration that is not a secret: auth method,
   * region, profile ARN, OAuth client id, token endpoint, scopes. The adapter
   * reads it where the credential is resolved (it selects the regional endpoint
   * and the profile the upstream binds the request to) and token refresh reads
   * it again to pick the right endpoint and client. Secrets never live here —
   * see `credential_ciphertext` and `provider_oauth_states`.
   */
  authState: jsonb("auth_state"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

  ...healthColumns(),
  modelCooldowns: jsonb("model_cooldowns").notNull().default({}),
  /**
   * How many times each model has been reported unsupported for this account:
   * `{ [modelId]: hits }`. Written only by the unsupported-model path, and it
   * is the escalation level for that pair's cooldown.
   *
   * Deliberately a separate column from `model_cooldowns`: that value is
   * `{ [modelId]: deadline }`, read by routing (`route-catalog.ts`) and by the
   * console, and widening it to `{until, hits}` would have changed a shape two
   * independent readers parse. Nullable — an account that never hit an
   * unsupported model has nothing to count.
   */
  modelBlockHits: jsonb("model_block_hits").$type<Readonly<Record<string, number>>>(),
  /**
   * Stable list position within (tenant, provider). Accounts were ordered by
   * `created_at`, which let two same-millisecond rows swap between loads; this
   * is explicit and can be rewritten when the operator reorders or appends.
   */
  sortIndex: integer("sort_index").notNull().default(0),
  /**
   * The credential is a static bearer token (a JWT/access token pasted on its
   * own, or an account an operator has pinned): it is used exactly as issued and
   * must never be sent to a refresh endpoint. Distinct from `credentialKind`,
   * which says what family the credential belongs to, not whether it can be
   * re-minted — an `oauth` account can carry a static token when its refresh
   * grant is absent or dead while the token itself is still valid. A static
   * account is skipped by the refresh sweep and is never disabled by a refresh
   * failure, because there is no refresh to run.
   */
  staticToken: boolean("static_token").notNull().default(false),
  /**
   * When this account's credential was last read for its own identity (email,
   * display name). Null means never read.
   *
   * This is the convergence stamp for the enrichment sweep, and the reason an
   * import can be instant: the batch path persists the credential without
   * parsing it, and the sweep fills the identity in afterwards. An account is
   * only listed while this is null, so a completed pass never re-decrypts a
   * credential it already read.
   */
  identityCheckedAt: timestamp("identity_checked_at", { withTimezone: true }),
  /**
   * Email read out of the account's own JWT claims. Cosmetic: it names the
   * account in the console and is never used to authenticate or route.
   */
  accountEmail: text("account_email"),

  /**
   * The plan the provider reports for this account, last seen by a quota read.
   *
   * Persisted rather than read from the quota cache: that cache is a short
   * in-process TTL and empty on a cold start, so the plan would be unknown
   * exactly when a freshly booted process makes its first routing decisions.
   *
   * Nullable: most providers report no plan at all, and an account never read
   * must say so rather than have a plan invented for it. Routing reads absence
   * as "unknown", never as "free" — guessing free would send pro-only traffic
   * to an account that may well be refused.
   */
  quotaPlan: text("quota_plan"),
  /**
   * When `quota_plan` was last written by a successful quota read.
   *
   * The plan column is a bare string with no timestamp, so routing cannot tell
   * a fresh plan from one recorded weeks ago. With the freshness horizon, a
   * stale plan is downgraded to `unknown` instead of being trusted blindly.
   */
  quotaPlanFetchedAt: timestamp("quota_plan_fetched_at", { withTimezone: true }),
  /**
   * The last successful quota read for this account, as a JSON snapshot.
   *
   * Persisted rather than left only in the quota cache: that cache is a short
   * in-process TTL and empty on a cold start, so right after a restart the
   * console would show no balance for every account until the sweep re-read
   * them. The row survives the restart, so a cold page open renders the last
   * known numbers immediately (and the sweep refreshes them). Only a
   * *successful* read is stored — a failed fetch leaves the previous snapshot
   * in place, mirroring the plan column's behaviour.
   */
  quotaSnapshot: jsonb("quota_snapshot").$type<ProviderQuotaResultSnapshot | null>(),

  /**
   * Qoder native machine identity bound to this account, as one JSON object
   * (see {@link NativeIdentityRecord}). `null` means the account has no bound
   * identity: the check-in mints one on first use.
   *
   * Deliberately a dedicated column, not a key inside `auth_state`: the
   * device token is queryable ("which device is taken by whom") and enforced
   * unique by the partial index below, and it must survive backup/restore
   * like any other non-secret column.
   */
  nativeIdentity: jsonb("native_identity").$type<NativeIdentityRecord | null>(),

  },
  (table) => [
    uniqueIndex("provider_accounts_identity_uidx").on(
      table.providerId,
      // No `::uuid` cast: the migrations create this index without one on
      // SQLite (baseline l.440) and with one on Postgres (l.423), and the
      // Drizzle definition is what a test's in-memory database is built
      // from — a Postgres-only cast there made every account insert fail
      // with `unrecognized token: ":"`.
      sql`coalesce(${table.tenantId}, '00000000-0000-0000-0000-000000000000')`,
      table.credentialFingerprint,
    ),
    index("provider_accounts_status_cooldown_idx").on(table.status, table.cooldownUntil),
    index("provider_accounts_provider_tenant_idx").on(table.providerId, table.tenantId),
    // The bare `tenant_id IS NULL OR tenant_id = ?` that `listAllAccounts`
    // uses is served by neither index above: `(status, cooldown_until)` leads
    // with the wrong column, and `(provider_id, tenant_id)` cannot serve a
    // predicate that does not constrain `provider_id`. This one matches the
    // hot listing path.
    index("provider_accounts_tenant_id_idx").on(table.tenantId),
    // One Qoder device identity per account: the partial unique index on the
    // extracted `machineToken` guarantees two accounts never share a device,
    // which is what makes the daily 100-credit grant reusable per account
    // instead of colliding on a device identity. `NULL` rows (unbound
    // accounts) are excluded so the uniqueness only applies to bound
    // identities. Migration 0049 additionally excludes `runtime-info`
    // identities: that bridge is machine-scoped (one token shared by every
    // account on one host), so uniqueness would flag legitimate sharing as a
    // spoof. The Postgres migration spells the expression
    // `(native_identity ->> 'machineToken')`; the SQLite migration spells it
    // `json_extract(native_identity, '$.machineToken')`.
    uniqueIndex("provider_accounts_native_identity_token_uidx")
      .on(sql`(${table.nativeIdentity} ->> 'machineToken')`)
      .where(
        sql`${table.nativeIdentity} IS NOT NULL AND ${table.nativeIdentity} ->> 'source' <> 'runtime-info'`,
      ),
  ],
);

//  OAuth refresh token + cross-process lease, normalized out of
// `provider_accounts` into its own 1:0/1 table. The vast majority of
// provider accounts are `credentialKind: "api_key"`, for which these four
// columns stayed null forever on the shared row; splitting them here keeps
// the hot health-machine row narrow and isolates the fenced compare-and-swap
// lease traffic (`providers/auth/refresh-service.ts`) from unrelated
// account reads/writes.
export const providerOauthStates = pgTable("provider_oauth_states", {
  providerAccountId: uuid("provider_account_id")
    .primaryKey()
    .references(() => providerAccounts.id, { onDelete: "cascade" }),
  /**
   * Encrypted refresh token. Nullable: an account can be pasted with only an
   * access token (or a credential whose refresh token never arrived), and the
   * account must still be tracked so the refresh sweep can flag it for re-auth
   * rather than leaving it invisible. A null value means "cannot refresh".
   */
  refreshCiphertext: bytea("refresh_ciphertext"),
  /**
   * Encrypted companion secret for the minority of flows whose refresh is not
   * authorized by the refresh token alone: a device-flow client registration
   * mints a client secret that must be replayed beside the token. Nullable —
   * most providers refresh with the refresh token by itself.
   */
  clientSecretCiphertext: bytea("client_secret_ciphertext"),
  /**
   * Access-token expiry. Nullable: a credential pasted without an expiry (an
   * opaque token, or a bare access token) has no known deadline, and reads as
   * "always due" so the sweep refreshes it as soon as it can.
   */
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  // OAuth refresh lease: fenced compare-and-swap coordination so only one
  // process refreshes a given account's OAuth token at a time, and a losing
  // process reloads instead of clobbering a peer's fresher token.
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
});

// One row per (provider_id, model_id, route), with `endpoint_path`
// identifying the route — the same model through two providers, or through
// two routes of one provider, is two rows. `enabled` is a hard routing
// invariant read by ProviderCatalogService, not a display-only flag.
export const models = pgTable(
  "models",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    providerId: text("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(),
    wireFamily: wireFamily("wire_family").notNull(),
    // Which protocol shape at all (`llm` = the canonical chat pipeline). A
    // non-`llm` row (System One) is served by its native passthrough route, not
    // by the surface codecs. Kept a plain text column with a default rather than
    // a pgEnum: unlike `wire_family`, the set is expected to grow (embeddings,
    // tts, …) and a widened enum needs a migration per addition.
    serviceKind: text("service_kind").notNull().default("llm"),
    endpointPath: text("endpoint_path").notNull(),
    contextLimit: integer("context_limit"),
    outputLimit: integer("output_limit"),
    modalities: jsonb("modalities"),
    reasoning: boolean("reasoning").notNull().default(false),
    toolCall: boolean("tool_call").notNull().default(false),
    cost: jsonb("cost"),
    // Display-only warning metadata for this row: Postgres `jsonb` (SQLite
    // `text` carrying the JSON string), nullable, `NULL` = no warnings. Shape:
    // `{ warnings: [{ kind, message, severity?, updatedAt? }] }`. Part of the
    // provider-account model-update proposal §3.4 area 06; not read by routing.
    warningMetadata: jsonb("warning_metadata"),
    source: text("source"),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    enabled: boolean("enabled").notNull().default(true),
    /**
     * Whether the upstream refuses this model on a free plan.
     *
     * Nullable three-valued: `true` refused on free, `false` served on free,
     * `NULL` nobody established it. `NULL` is the state of every model on every
     * provider that publishes nothing about plan access, and collapsing it to
     * `false` would assert a measured fact for rows nobody measured.
     *
     * A column rather than a derived rule because CodeBuddy publishes nothing
     * that predicts access — `credits` and `vendor` were both measured against
     * real dispatches and neither correlates. Only the refusal itself is a
     * signal, so the answer has to be recorded. See
     * `documentation/research/codebuddy/2026-10-19-codebuddy-chat-dispatch-headers.md`.
     */
    proOnly: boolean("pro_only"),
    /**
     * Whether the provider publishes this model as free.
     *
     * Mirrors `proOnly` but sourced from the provider's own directory rather
     * than inferred: Qoder states `is_free` per row, so the tier tracks a plan
     * change without a code change. Nullable three-valued — absence means the
     * provider did not state it, which is not the same as billed.
     */
    freeTier: boolean("free_tier"),
    /**
     * Explicit wire dialect for this row (nullable). Absent = resolver
     * fallback (heuristic + family default). See
     * `src/protocol/translation/dialect/`.
     */
    dialect: text("dialect"),
  },
  (table) => [
    uniqueIndex("models_provider_model_route_uidx").on(
      table.providerId,
      table.modelId,
      table.endpointPath,
    ),
    index("models_provider_enabled_idx").on(table.providerId, table.enabled),
    // Bare-id lookups, with no provider named: see migration
    // `0003_add_models_model_id_index`. Without it those seq-scan this table,
    // which carries one row per provider x model x route.
    index("models_model_id_idx").on(table.modelId),
  ],
);

// Tenant-scoped suppression of a GLOBAL/built-in model. Tenants cannot mutate
// the shared `models` row (see `DrizzleProviderCatalogStore.setModelEnabled`),
// so a disable is recorded here and filtered out of that tenant's routing
// snapshot. Tenant-owned/BYOK models are still toggled directly on `models`.
export const tenantDisabledModels = pgTable(
  "tenant_disabled_models",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantRefRequired(),
    providerId: text("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(),
    endpointPath: text("endpoint_path").notNull(),
    createdAt: createdAtColumn(),
  },
  (t) => [
    uniqueIndex("tenant_disabled_models_tenant_provider_model_uidx").on(
      t.tenantId,
      t.providerId,
      t.modelId,
      t.endpointPath,
    ),
  ],
);

// Tenant-owned HTTP/HTTPS/SOCKS5 pools share the provider-account health state machine.
export const networkPools = pgTable("network_pools", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  kind: networkPoolKind("kind").notNull(),
  /**
   * Operator-set family/tag for this pool, e.g. `residential-id` or
   * `datacenter-sg`. Purely organisational: it names which family the node
   * belongs to and nothing in routing or dispatch reads it. Null when the
   * operator has not tagged the pool.
   */
  family: text("family"),
  endpointConfig: jsonb("endpoint_config").notNull(),
  credentialCiphertext: bytea("credential_ciphertext"),
  maxInflight: integer("max_inflight"),
  /** Routing weight for weighted selection across the tenant pool group. */
  weight: integer("weight"),
  tenantId: tenantRefRequired(),

  ...healthColumns(),
  lastLatencyMs: integer("last_latency_ms"),
  lastHealthCheckAt: timestamp("last_health_check_at", { withTimezone: true }),
  /** Public egress address reported by the last successful probe; null until probed. */
  egressIp: text("egress_ip"),
  /** Operator-set egress allowance in bytes; null means unmetered. */
  quotaBytes: bigint("quota_bytes", { mode: "number" }),
  /** Last speed-test payload actually transferred, in bytes; null until measured. */
  lastSpeedtestBytes: integer("last_speedtest_bytes"),
  /** Wall-clock duration of the last speed-test transfer, in milliseconds. */
  lastSpeedtestDurationMs: integer("last_speedtest_duration_ms"),
  /** "ok" | "failed" for the last speed-test; null until measured. */
  lastSpeedtestStatus: text("last_speedtest_status"),
  /** Failure message of the last speed-test; null on success or unmeasured. */
  lastSpeedtestError: text("last_speedtest_error"),
  /** When the last speed-test ran. */
  lastSpeedtestAt: timestamp("last_speedtest_at", { withTimezone: true }),
  /**
   * Provider-scoped probe verdict, stored beside the other last-known facts
   * (`egress_ip`, `last_latency_ms`, the speed-test columns) rather than in the
   * browser.
   *
   * Browser storage is not enough: a verdict held only there is visible to the
   * operator who ran it and to nobody else — not to another machine, not to the
   * gateway, and not to admission. A pool would read "OpenCode blocked" on
   * screen while dispatch kept sending traffic through it, because nothing
   * outside that one browser had heard the verdict.
   *
   * `null` means never probed. These describe the *address* recorded in
   * `egress_ip` at the time, so a changed endpoint clears them.
   */
  providerProbeProviderId: text("provider_probe_provider_id"),
  /** `allowed` | `blocked` | `throttled` | `unreachable`; null until probed. */
  providerProbeStatus: text("provider_probe_status"),
  /** Upstream HTTP status when a response arrived. */
  providerProbeHttpStatus: integer("provider_probe_http_status"),
  /** Operator-facing reason: the upstream's own words, or why the probe failed. */
  providerProbeReason: text("provider_probe_reason"),
  providerProbeLatencyMs: integer("provider_probe_latency_ms"),
  providerProbeAt: timestamp("provider_probe_at", { withTimezone: true }),
  /** The endpoint the verdict was measured against. Compared on read, so an
   * edited endpoint reports "never probed" instead of a stale verdict. */
  providerProbeEndpoint: text("provider_probe_endpoint"),
  /**
   * The database mirror of the pool selector's provider cooldown state, one
   * entry per cooling provider keyed by its lowercased id:
   * `{ "opencode": { "until": <epoch ms>, "reason": "...", "blocked": false } }`.
   *
   * The selector's own map is process-local (mirrored to Redis when present),
   * so a restart dropped every flag while the upstream kept refusing the
   * egress — dispatch re-picked a spent pool and the console showed nothing.
   * The dispatch-side flaggers write each marker here, and boot reads this
   * column back into the selector, so the state survives a restart the way the
   * upstream's memory of the address does.
   *
   * `null` means no provider was ever flagged. Expired entries are left inert
   * until the next write for the pool rather than swept eagerly: a marker with
   * `until` in the past is skipped by every reader.
   */
  providerCooldowns: jsonb("provider_cooldowns")
    .$type<Record<string, { until: number; reason: string; blocked?: boolean }>>(),
  /** Metered egress totals, flushed from the in-memory socket counters on
   * every pool-touching write so the quota bar survives a restart. */
  bytesSentTotal: bigint("bytes_sent_total", { mode: "number" }).notNull().default(0),
  /** Metered ingress totals; see `bytesSentTotal`. */
  bytesReceivedTotal: bigint("bytes_received_total", { mode: "number" }).notNull().default(0),
  },
  (table) => [
    index("network_pools_tenant_id_idx").on(table.tenantId),
    index("network_pools_status_cooldown_idx").on(table.status, table.cooldownUntil),
    index("network_pools_family_idx").on(table.family),
  ],
);

/**
 * A pool's account-equivalent routing entity for ip-scoped, credential-less
 * providers (OpenCode Free today).
 *
 * These providers own no `provider_accounts` rows — the rate limit belongs to
 * the egress address, not to a credential. Materializing one row per (pool,
 * ip-scoped provider) lets the account health machine, routing eligibility, and
 * the provider-detail accounts UI treat each egress like an account: the row
 * carries the same health state machine and cooldown columns, so a spent egress
 * is excluded from the plan the same way a cooling account is, and the operator
 * sees it in the provider's Accounts card with a "Pool" badge.
 *
 * The row is an *account-equivalent*, not an account: it resolves no credential
 * (`credential_kind` is fixed to `none`-style egress), is skipped by the quota
 * refresh and identity sweeps (they filter on real credential kinds), and is
 * owned by its pool — deleting the pool cascades the row.
 */
export const providerPoolAccounts = pgTable(
  "provider_pool_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantRefRequired(),
    networkPoolId: uuid("network_pool_id")
      .notNull()
      .references(() => networkPools.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    label: text("label").notNull(),
    ...healthColumns(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("provider_pool_accounts_pool_provider_uidx").on(
      table.networkPoolId,
      table.providerId,
      table.tenantId,
    ),
    index("provider_pool_accounts_tenant_status_idx").on(table.tenantId, table.status),
    index("provider_pool_accounts_provider_status_idx").on(table.providerId, table.status),
  ],
);

// Account and network-pool health events share one table. The entity kind
// selects exactly one owner FK, and the CHECK constraint below preserves
// referential integrity for both variants.
export const healthEvents = pgTable(
  "health_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityKind: healthEntityKind("entity_kind").notNull(),
    accountId: uuid("account_id").references(() => providerAccounts.id, { onDelete: "cascade" }),
    networkPoolId: uuid("network_pool_id").references(() => networkPools.id, {
      onDelete: "cascade",
    }),
    fromStatus: healthStatus("from_status"),
    toStatus: healthStatus("to_status").notNull(),
    reason: text("reason"),
    errorCategory: text("error_category"),
    modelId: text("model_id"),
    createdAt: createdAtColumn(),
  },
  (table) => [
    index("health_events_account_id_created_at_idx").on(table.accountId, table.createdAt),
    // Descending `created_at` is deliberate: health history is always read
    // newest-first. The SQLite baseline drops the direction (see
    // `scripts/tools/generate-sqlite.ts` — SQLite scans an index either way),
    // so this is a Postgres-only access-path choice, not a cross-backend
    // disagreement.
    index("health_events_account_model_created_idx").on(
      table.accountId,
      table.modelId,
      desc(table.createdAt),
    ),
    index("health_events_network_pool_id_created_at_idx").on(table.networkPoolId, table.createdAt),
    check(
      "health_events_entity_reference_check",
      sql`(${table.entityKind} = 'account' AND ${table.accountId} IS NOT NULL AND ${table.networkPoolId} IS NULL) OR (${table.entityKind} = 'pool' AND ${table.networkPoolId} IS NOT NULL AND ${table.accountId} IS NULL)`,
    ),
  ],
);
