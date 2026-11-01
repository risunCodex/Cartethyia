/** Canonical Drizzle schema: every persistence table, enum, index, and shared type. */
import { desc, sql } from "drizzle-orm";
import {
  bigint, boolean, check, customType, index, integer, jsonb, numeric, pgEnum, pgTable,
  primaryKey, text, timestamp, unique, uniqueIndex, uuid, type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const TENANT_STATUSES = ["active", "suspended", "deleted"] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    status: text("status").$type<TenantStatus>().notNull(),
    // Intentionally inline (not createdAtColumn()): this root table is imported
    // by the helpers below; sharing the helper here would make a use-before-define.
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("tenants_status_check", sql`${table.status} IN ('active', 'suspended', 'deleted')`),
  ],
);

// Canonical tenant/timestamp column definitions shared by every table.

export function tenantRefNullable() {
  return uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" });
}

export function tenantRefRequired() {
  return uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" });
}

export function tenantRefPrimaryKey() {
  return uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" });
}

export function tenantCascadeSetNull() {
  return uuid("tenant_id").references(() => tenants.id, { onDelete: "set null" });
}

export function createdAtColumn() {
  return timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
}

export function updatedAtColumn() {
  return timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
}

export function timestampColumns() {
  return { createdAt: createdAtColumn(), updatedAt: updatedAtColumn() };
}

/**
 * `bytea` column for encrypted credential ciphertext (application-layer
 * envelope encryption: the ciphertext stored here is opaque to the
 * database). Drizzle's pg-core does not ship a first-class `bytea`
 * builder, so this is the documented `customType` escape hatch (the same
 * DDL-shape escape-hatch principle applied to column-type gaps in the
 * ORM's builder).
 */
export const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// Shared three-state health machine for provider_accounts and network_pools —
// the account state machine is reused for network pools rather than
// inventing a second one.
//
// `degraded` was retired. It sat between "working" and "parked" and every
// consumer had to decide what it meant: routing treated it as a hard exclusion,
// the sweep treated it as recoverable, and the console showed it as a third
// badge — three readings of one value, and the operator reported the result as
// ambiguous. The two facts it mixed are now each stated by a value that means
// exactly one thing: a fault that clears on its own is `cooldown` (with a
// deadline the sweep honors), and a fault that needs an operator is `disabled`.
export const healthStatus = pgEnum("health_status", ["active", "cooldown", "disabled"]);

/**
 * The health state machine shared by `provider_accounts` and `network_pools`.
 * One definition, because the two tables are driven by the same transitions and
 * a column added to one of them by hand is how they drift.
 */
export function healthColumns() {
  return {
    status: healthStatus("status").notNull().default("active"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastErrorCategory: text("last_error_category"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
    lastRecoveredAt: timestamp("last_recovered_at", { withTimezone: true }),
  };
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

export const telemetrySourceSurface = pgEnum("telemetry_source_surface", [
  "chat",
  "responses",
  "messages",
  "completion",
]);

export const telemetryStatus = pgEnum("telemetry_status", [
  "completed",
  "failed",
  "cancelled",
  "truncated",
]);

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
  /** How this identity was produced: the genuine SG bridge or the fallback. */
  readonly source?: "runtime-info" | "generated";
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
    // identities. The Postgres migration spells the expression
    // `(native_identity ->> 'machineToken')`; the SQLite migration spells it
    // `json_extract(native_identity, '$.machineToken')`.
    uniqueIndex("provider_accounts_native_identity_token_uidx")
      .on(sql`(${table.nativeIdentity} ->> 'machineToken')`)
      .where(sql`${table.nativeIdentity} IS NOT NULL`),
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
     * `.skills/cartethyia-reverse-engineering/references/codebuddy-dispatch-headers.md`.
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
export type ProviderPoolAccount = typeof providerPoolAccounts.$inferSelect;


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


// Model aliasing & combos. Aliases resolve a client-facing name to a
// real model; combos back a client-facing name with >=1 real models,
// auto-selected via `fallback` or `round_robin`.
export const modelComboStrategy = pgEnum("model_combo_strategy", [
  "fallback",
  "round_robin",
]);

/** Canonical `ComboStrategy` union, derived from the enum above. Console
 * domain and routing layers import this instead of hand-typing their own mirror.
 * `ProviderRoutingStrategy` covers the same two values but persists on
 * `provider_routing_settings` beside `rotateCount`. */
export type ComboStrategy = (typeof modelComboStrategy.enumValues)[number];

export const modelAliases = pgTable(
  "model_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantRefRequired(),
    alias: text("alias").notNull(),
    targetModel: text("target_model").notNull(),
    /** Explicit list position. */
    sortIndex: integer("sort_index").notNull().default(0),
    ...timestampColumns(),
  },
  (t) => [uniqueIndex("model_aliases_tenant_alias_uidx").on(t.tenantId, t.alias)],
);
export type ModelAlias = typeof modelAliases.$inferSelect;

export const modelCombos = pgTable(
  "model_combos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantRefRequired(),
    name: text("name").notNull(),
    members: jsonb("members").notNull().$type<string[]>(),
    strategy: modelComboStrategy("strategy").notNull().default("fallback"),
    /** Explicit list position. */
    sortIndex: integer("sort_index").notNull().default(0),
    ...timestampColumns(),
  },
  (t) => [uniqueIndex("model_combos_tenant_name_uidx").on(t.tenantId, t.name)],
);
export type ModelCombo = typeof modelCombos.$inferSelect;

export const providerRoutingStrategy = pgEnum("provider_routing_strategy", [
  "fallback",
  "round_robin",
]);

/**
 * Canonical provider-routing strategy union, derived from the enum above so
 * the persisted values and the type cannot drift. The console catalog and the
 * routing engine both import this instead of restating the two literals.
 */
export type ProviderRoutingStrategy = (typeof providerRoutingStrategy.enumValues)[number];

/**
 * Per-account inflight ceiling applied when a provider has no routing row yet.
 * One literal: the console default and the route catalog's fallback both read
 * it. `null` is the "unlimited" choice, and it is also this default — an
 * operator who has never opened the routing card asked for no ceiling, and
 * inventing one silently capped their concurrency. A ceiling they *did* set is
 * still honoured, so this only decides the untouched case.
 */
export const DEFAULT_PROVIDER_MAX_INFLIGHT: null = null;

export const providerRoutingSettings = pgTable(
  "provider_routing_settings",
  {
    providerId: text("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    tenantId: tenantRefNullable(),
    strategy: providerRoutingStrategy("strategy").notNull().default("fallback"),
    /** Requests served by one account before round robin advances. */
    rotateCount: integer("rotate_count").notNull().default(1),
    /** Per-account inflight ceiling applied to every account of this provider
     * (the field sits next to the failover/round-robin strategy in the UI).
     * `null` = UNLIMITED concurrency per account. */
    maxInflight: integer("max_inflight"),
    /**
     * Per-pool inflight ceiling for this provider: how many concurrent
     * requests one proxy pool may carry *for this provider*.
     *
     * A second, independent axis from `maxInflight`. That one bounds a single
     * account; `network_pools.max_inflight` bounds a pool across every
     * provider; this one bounds one provider's share of one pool. All three
     * are enforced together — none replaces another.
     *
     * `null` = unlimited, and that is the default: an unconfigured provider
     * costs no extra Redis key and no extra round trip.
     */
    maxInflightPerProxy: integer("max_inflight_per_proxy"),
    /**
     * Minimum remaining allowance an account must hold to stay routable, for
     * this provider. `null` means no floor. Compared against the account's own
     * unit: absolute remaining credit when the provider reports credits, the
     * aggregate credit percentage and lowest independent percentage window
     * otherwise. An account below it is skipped and the request fails over to
     * the next account instead of erroring.
     */
    usageFloor: integer("usage_floor"),
    /** `credit` compares the summed remaining credit; `percent` compares the
     * aggregate credit percentage and lowest independent percentage-only
     * window. Ignored while `usageFloor` is null. */
    usageFloorUnit: text("usage_floor_unit").$type<"credit" | "percent">().notNull().default("percent"),
    enabled: boolean("enabled").notNull().default(false),
    // Route-selected User-Agent for built-in API-key providers; OAuth and BYOK identities stay native.
    // The column default is the Claude Code CLI identity; the live default for a
    // row that never set one is `buildClaudeCliUserAgent()` in
    // providers/operations/custom-cli-headers.ts, which this mirrors.
    userAgent: text("user_agent").notNull().default("claude-cli/2.1.293 (external, cli)"),
    // When true, this provider's requests always dial direct. When false,
    // dispatch automatically selects among every active network pool the
    // tenant owns (least-loaded/non-cooldown) — never an admin-pinned pool.
    skipProxy: boolean("skip_proxy").notNull().default(false),
  },
  (table) => ({
    tenantProviderUnique: uniqueIndex("provider_routing_settings_tenant_provider_idx").on(
      table.tenantId,
      table.providerId,
    ),
    globalProviderUnique: uniqueIndex("provider_routing_settings_global_provider_idx")
      .on(table.providerId)
      .where(sql`tenant_id IS NULL`),
  }),
);

export const poolRoutingStrategy = pgEnum("pool_routing_strategy", [
  "least_loaded",
  "round_robin",
  "random",
]);
export type PoolRoutingStrategy = (typeof poolRoutingStrategy.enumValues)[number];

/**
 * Per-tenant selection strategy across the tenant's active network pools —
 * the pool-group counterpart to `provider_routing_settings`. `least_loaded`
 * (default) keeps the weighted least-loaded scan with its rotating tie-break;
 * `round_robin` serves `rotate_count` requests per pool before advancing,
 * mirroring the account strategy, and skips capacity/cooldown pools the way
 * account failover does. An absent row reads as the default, so tenants that
 * never touch the toggle own no rows.
 */
export const poolRoutingSettings = pgTable("pool_routing_settings", {
  tenantId: tenantRefPrimaryKey(),
  strategy: poolRoutingStrategy("strategy").notNull().default("least_loaded"),
  /** Requests served by one pool before round robin advances. */
  rotateCount: integer("rotate_count").notNull().default(1),
});


export const API_KEY_MODES = ["personal", "share"] as const;
export type ApiKeyMode = (typeof API_KEY_MODES)[number];

/**
 * How a key's `modelList` is interpreted. Exactly two modes, never a
 * combination: `whitelist` allows only the listed names (an empty list allows
 * everything), `blacklist` refuses the listed names (an empty list refuses
 * nothing). Every model-authorization surface — the request path, admission,
 * `/v1/models`, and the share page — reads this one pair.
 */
export const API_KEY_MODEL_ACCESS_MODES = ["whitelist", "blacklist"] as const;
export type ApiKeyModelAccessMode = (typeof API_KEY_MODEL_ACCESS_MODES)[number];

/** Share-template concurrency scope — see `apiKeys.concurrencyScope`. */
export const API_KEY_CONCURRENCY_SCOPES = ["family", "per_key"] as const;
export type ApiKeyConcurrencyScope = (typeof API_KEY_CONCURRENCY_SCOPES)[number];

/**
 * Inbound `/v1/*` keys never store plaintext secrets. Personal keys carry an
 * authentication hash; share templates carry policy and child keys point back
 * to the template that issued them.
 */
export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantRefRequired(),
    keyHash: text("key_hash"),
    keyMode: text("key_mode").$type<ApiKeyMode>().notNull().default("personal"),
    parentKeyId: uuid("parent_key_id").references(
      (): AnyPgColumn => apiKeys.id,
      { onDelete: "cascade" },
    ),
    issuedClientIp: text("issued_client_ip"),
    issuedClientIpKey: text("issued_client_ip_key"),
    label: text("label").notNull(),
    scopes: jsonb("scopes").notNull().$type<readonly string[]>(),
    // Only the non-secret public key prefix is returned to the owner.
    keyPrefix: text("key_prefix"),
    // Personal keys retain an encrypted copy for the CLI handoff. Shared
    // children are revealed once and persist only their authentication hash.
    keyEncrypted: bytea("key_encrypted"),
    notesTitle: text("notes_title"),
    notesSubtitle: text("notes_subtitle"),
    notesBody: text("notes_body"),
    /** Explicit list position. */
    sortIndex: integer("sort_index").notNull().default(0),
    requestsPerMinute: integer("requests_per_minute"),
    dailyTokenLimit: bigint("daily_token_limit", { mode: "number" }),
    monthlyTokenLimit: bigint("monthly_token_limit", { mode: "number" }),
    lifetimeTokenBudget: bigint("lifetime_token_budget", { mode: "number" }),
    lifetimeTokensConsumed: bigint("lifetime_tokens_consumed", { mode: "number" })
      .notNull()
      .default(0),
    maxConcurrentRequests: integer("max_concurrent_requests"),
    /**
     * How `maxConcurrentRequests` applies to a share family:
     *
     * - `family` (default) — one cap across the whole family: every recipient
     *   key shares the same admission counter and budget, so 20 means 20
     *   concurrent requests across all children of the template.
     * - `per_key` — each recipient key gets its own independent concurrent
     *   window and cap. The cap is copied from the template to each child at
     *   issue time (children carry their own `maxConcurrentRequests`), and a
     *   child's admission identity is its own id, not the parent's.
     *
     * Only meaningful for `share` keys; personal keys always use their own
     * per-key cap.
     */
    concurrencyScope: text("concurrency_scope")
      .$type<ApiKeyConcurrencyScope>()
      .notNull()
      .default("family"),
    /**
     * Slot cap for a share template: the maximum number of concurrently
     * active child keys it may mint. `null` = unlimited (legacy behavior).
     * Enforced at mint time in `issueSharedApiKey`; the console exposes it as
     * the template's "slots".
     */
    maxChildren: integer("max_children"),
    /**
     * `whitelist` = only the names in `modelList` may be used (empty = all);
     * `blacklist` = the names in `modelList` are refused (empty = none). One
     * list, one mode.
     */
    modelAccessMode: text("model_access_mode")
      .$type<ApiKeyModelAccessMode>()
      .notNull()
      .default("whitelist"),
    modelList: jsonb("model_list").$type<readonly string[]>(),
    /**
     * Client-router ids this key refuses. A request whose fingerprint names one
     * of these is rejected before routing, so an operator can stop a downstream
     * router from spending the key. Empty/NULL means "no router is refused".
     *
     * A label, not a security control: a client that sends no fingerprint is
     * simply not matched, which is why this is a per-key policy rather than a
     * boundary anything else in the system trusts.
     */
    clientRouterDenylist: jsonb("client_router_denylist").$type<readonly string[]>(),
    modelPrefix: text("model_prefix"),
    createdAt: createdAtColumn(),
    enabled: boolean("enabled").notNull().default(true),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /**
     * Ban state. A ban is distinct from a revoke: it records the operator's
     * reason (`banReason`) so the console can show it, and it is fully
     * reversible — unban clears both columns, leaving no metadata behind.
     * Banned keys are rejected by the auth path exactly like revoked keys.
     */
    bannedAt: timestamp("banned_at", { withTimezone: true }),
    banReason: text("ban_reason"),
    /**
     * When the ban lifts on its own, if it is not permanent. `null` means the
     * ban does not lapse (until an operator unbans it). The auth path treats a
     * key as banned only while `banned_at` is set and `banned_until` is either
     * null or in the future — so a timed ban expires without SQL.
     */
    bannedUntil: timestamp("banned_until", { withTimezone: true }),
    /**
     * The tenant's mandatory gateway key. Seeded at first boot whether or not
     * `CARTETHYIA_API_KEY` was configured, and the one key the console refuses
     * to revoke — it may only be rotated. A column rather than a label match,
     * so renaming the key cannot break the CLI lookup or let a second
     * default be created.
     */
    isDefault: boolean("is_default").notNull().default(false),
  },
  (table) => [
    uniqueIndex("api_keys_key_hash_idx").on(table.keyHash),
    /**
     * One *live* default key per tenant, enforced by the database.
     *
     * This is the only database-level guarantee behind `isDefault`, and
     * `test/persistence/sqlite-baseline.test.ts` pins it by name — so the
     * schema must keep declaring it to match the baseline.
     *
     * Partial on `revoked_at IS NULL` so a tenant can rotate its default key
     * without the old, revoked row blocking the new one.
     */
    uniqueIndex("api_keys_one_default_per_tenant_uidx")
      .on(table.tenantId)
      .where(sql`${table.isDefault} = true AND ${table.revokedAt} IS NULL`),
    index("api_keys_tenant_id_idx").on(table.tenantId),
    index("api_keys_enabled_tenant_idx").on(table.tenantId).where(sql`${table.enabled} = true`),
    index("api_keys_parent_key_id_idx").on(table.parentKeyId),
    check(
      "api_keys_mode_shape_check",
      sql`(
        (${table.keyMode} = 'personal' AND ${table.keyHash} IS NOT NULL
          AND ${table.parentKeyId} IS NULL AND ${table.issuedClientIp} IS NULL
          AND ${table.issuedClientIpKey} IS NULL)
        OR
        (${table.keyMode} = 'share' AND (
          (${table.parentKeyId} IS NULL AND ${table.keyHash} IS NULL
            AND ${table.keyEncrypted} IS NULL
            AND ${table.issuedClientIp} IS NULL AND ${table.issuedClientIpKey} IS NULL)
          OR
          (${table.parentKeyId} IS NOT NULL AND ${table.keyHash} IS NOT NULL
            AND ${table.keyEncrypted} IS NULL
            AND ${table.issuedClientIp} IS NOT NULL AND ${table.issuedClientIpKey} IS NOT NULL)
        ))
      )`,
    ),
  ],
);

/**
 * The optional popup a share link shows its recipient. Kept off `api_keys`
 * because the auth path reads that row on every request and the popup is
 * absent for nearly all of them. One row per key, present only when the owner
 * configured one.
 */
export const sharePopups = pgTable(
  "share_popups",
  {
    apiKeyId: uuid("api_key_id")
      .primaryKey()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    image: bytea("image"),
    imageMime: text("image_mime"),
    title: text("title"),
    body: text("body"),
  },
  (table) => [
    check(
      "share_popups_image_mime_check",
      sql`${table.imageMime} IS NULL OR ${table.imageMime} IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')`,
    ),
    check(
      "share_popups_image_size_check",
      sql`${table.image} IS NULL OR octet_length(${table.image}) <= 2097152`,
      // SQLite has no octet_length. The generator rewrites this check to
      // `length(`; both count bytes for a blob column.
    ),
  ],
);


// Public bearer links for enrolling one shared key per resolved client IP, and
// for handing a personal key to its owner. The hash is the lookup key; the
// token is additionally retained encrypted so the owner's console can show the
// link again instead of losing it after the one response that minted it.
/**
 * Share-link kinds, as a runtime tuple. Route schemas and DTOs project this
 * list rather than restating it.
 */
export const SHARE_LINK_KINDS = ["enroll", "handoff"] as const;

/** One share-link kind. */
export type ShareLinkKind = (typeof SHARE_LINK_KINDS)[number];


export const shareLinks = pgTable(
  "share_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    // Encrypted bearer token. Present so the console can re-display a stable
    // link; nullable, and a NULL row simply cannot be shown again.
    tokenEncrypted: bytea("token_encrypted"),
    /**
     * The public slug this page is reachable at, in the clear.
     *
     * `tokenEncrypted` is the bearer token under the deployment's encryption
     * key, so a link cannot be re-displayed once that key changes — which is
     * exactly what a restore onto a fresh deployment does. Holding the slug
     * unencrypted keeps every restored share page reachable under the address
     * it was created with.
     *
     * Nullable: a row without a slug has no address, and inventing one
     * would publish an address the page never had.
     */
    slug: text("slug"),
    kind: text("kind").$type<ShareLinkKind>().notNull().default("enroll"),
    active: boolean("active").notNull().default(true),
    createdAt: createdAtColumn(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("share_links_token_hash_idx").on(table.tokenHash),
    // Partial: rows without a slug are not constrained, so backfilling is never
    // blocked by a uniqueness collision.
    uniqueIndex("share_links_slug_uidx").on(table.slug).where(sql`${table.slug} IS NOT NULL`),
    index("share_links_api_key_idx").on(table.apiKeyId),
    index("share_links_active_kind_expires_idx").on(table.active, table.kind, table.expiresAt),
    check("share_links_kind_check", sql`${table.kind} IN ('enroll', 'handoff')`),
  ],
);


/**
 * Console dashboard users — distinct from API-key tenants.
 */
export const consoleUsers = pgTable(
  "console_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantRefRequired(),
    username: text("username").notNull(),
    email: text("email"),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name"),
    isActive: boolean("is_active").notNull().default(true),
    isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
    isFirstBoot: boolean("is_first_boot").notNull().default(true),
    ...timestampColumns(),
  },
  (table) => [
    index("console_users_tenant_id_idx").on(table.tenantId),
    uniqueIndex("console_users_tenant_username_uidx").on(table.tenantId, table.username),
  ],
);

export type ConsoleUser = typeof consoleUsers.$inferSelect;

/**
 * Console sessions — HTTP-only, signed cookies.
 * Session metadata only; no secrets in JSON.
 */
export const consoleSessions = pgTable(
  "console_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => consoleUsers.id, { onDelete: "cascade" }),
    sessionToken: text("session_token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    index("console_sessions_user_id_idx").on(table.userId),
  ],
);

export type ConsoleSession = typeof consoleSessions.$inferSelect;

/**
 * Console login lockout tracking — fail-closed rate limiting keyed by
 * client IP (login attempts happen before any user identity is known, so
 * this cannot be keyed by `console_users.id`). Persisted so a ban survives
 * a process restart and is shared across every app instance, instead of a
 * static in-process map that a second instance or a redeploy would forget.
 */
export const consoleLockouts = pgTable(
  "console_lockouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ip: text("ip").notNull(),
    failureCount: integer("failure_count").notNull().default(0),
    windowUntil: timestamp("window_until", { withTimezone: true }),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    reason: text("reason"),
    ...timestampColumns(),
  },
  (table) => [
    uniqueIndex("idx_console_lockouts_ip").on(table.ip),
  ],
);


// Configuration-change audit has its own retention lifecycle; it is separate
// from metadata telemetry and short-lived optional payload capture.
export const adminAuditLog = pgTable(
  "admin_audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: createdAtColumn(),
    actor: text("actor").notNull(),
    tenantId: tenantCascadeSetNull(),
    action: text("action").notNull(),
    target: text("target").notNull(),
    detail: jsonb("detail"),
  },
  (table) => [
    index("admin_audit_log_tenant_id_created_at_id_idx").on(
      table.tenantId,
      table.createdAt,
      table.id,
    ),
  ],
);


// Runtime preferences are stored in one validated JSONB bag. The filter
// master toggle remains a typed column because it is read on the proxy path.
export interface ConsoleSettingsPreferences {
  tenantConcurrencyLimit?: number | null;
  /** Normalizes provider-native thinking config for non-user final turns. */
  thinkingNormalizationEnabled?: boolean;
  responsesReasoningSummary?: "auto" | "concise" | "detailed";
  /**
   * Request compression: compact bulky tool-result text in the message history
   * before dispatch (RTK prune). Default off.
   */
  rtkPruneEnabled?: boolean;
  /** RTK prune strength when enabled (`lite`/`full`/`ultra`); `full` when unset. */
  rtkPruneLevel?: "lite" | "full" | "ultra";
  /**
   * Request compression: append a minimal-code directive to the system content.
   * Default off; `ponyTailLevel` selects the intensity when on.
   */
  ponyTailEnabled?: boolean;
  /** PonyTail directive intensity; `full` when unset. Only applied when enabled. */
  ponyTailLevel?: "lite" | "full" | "ultra" | null;
  /**
   * Payload capture mode (default `none` when unset):
   * - `metadata` — Proxy→Provider method + allowlisted headers only
   * - `full` — full redacted bodies up to the configured capture limit
   * - `none` — no drawer capture (request metadata events still retained)
   */
  telemetryPayloads?: "full" | "metadata" | "none";
  /**
   * Capture depth for `full` mode (default `minimum` when unset). Fixed size
   * tiers so every debug sees all four drawer panels — only the cap changes:
   * - `minimum` — 1 MiB combined cap, light enough to leave on
   * - `moderate` — 8 MiB combined cap, expect CPU/memory spikes while active
   * - `maximum` — 16 MiB combined cap, expect CPU/memory spikes while active
   */
  telemetryPayloadDepth?: "minimum" | "moderate" | "maximum";

  privacyMode?: "masked" | "full";
  /**
   * Ignores an account-wide cooldown when building route candidates.
   *
   * Off by default, and deliberately dangerous: an account in cooldown was
   * parked because the upstream refused it, and dialing it anyway reproduces
   * that refusal on every attempt. Turning this on can exhaust the candidate
   * list and fail a request that would otherwise have been routed.
   *
   * The override is read-only — the cooldown is still recorded, still shown in
   * Health, and still recovered by the sweep. Nothing is written back, so the
   * toggle can be turned off again without cleaning anything up.
   *
   * Per-(account, model) cooldowns are NOT overridden. Those are usually a
   * named quota ("daily free limit reached, try again in 11h") where the
   * upstream stated a real reset; ignoring it only buys repeated refusals.
   */
  forceDisableCooldown?: boolean;
  /**
   * Stops every invoke and route for this tenant. Off by default.
   *
   * A kill switch, not a routing tweak: while it is on, `/v1/*` returns 503 and
   * nothing is dispatched upstream. The console keeps working, which is the
   * point — an operator must be able to stop traffic and still reach the UI
   * that turns it back on.
   */
  invokeDisabled?: boolean;
  /**
   * Slack added on top of every key's concurrency limit for this tenant.
   *
   * `maxConcurrentRequests` is the number an operator chose and what a
   * refusal names; this is deliberate allowance above it so a run landing a
   * few over is not refused at that number. Effective ceiling is
   * `limit + tolerance`, and only requests past it are refused — never ones
   * already admitted.
   */
  concurrencyTolerance?: number | null;
  /**
   * Per-tenant upstream request timeout in seconds, overriding
   * `CARTETHYIA_UPSTREAM_TIMEOUT_MS`. `null` or absent means use the
   * deployment default.
   */
  upstreamTimeoutSeconds?: number | null;
  /** Captured payload detail lifetime in minutes; null means deployment default. */
  telemetryWindowMinutes?: number | null;

  /**
   * Per-tenant ceiling for one inline attachment, in bytes, overriding the
   * deployment default of 10 MB.
   *
   * Raising this asserts that this tenant's upstreams accept larger
   * attachments. The clamp is a hard send gate precisely because an oversized
   * block poisons every retry and every replayed turn — the upstream rejects
   * the whole request rather than the one block — so an override larger than
   * the provider actually accepts trades that protection away. Lowering it is
   * the safer direction and the more common need.
   */
  imageClampMaxBytes?: number | null;
  /**
   * Ordered list of vision model ids (`provider/model`) used to describe
   * images when the selected model is not image-capable. The first healthy
   * model wins; if it fails (cooldown/quota/upstream error), the handoff
   * falls through to the next entry. Empty/absent = legacy `[image]`
   * placeholder behavior.
   */
  visionHandoffModels?: readonly string[];
}

export const consoleSettings = pgTable("console_settings", {
  tenantId: tenantRefPrimaryKey(),
  preferences: jsonb("preferences").notNull().default({}).$type<ConsoleSettingsPreferences>(),
  updatedAt: updatedAtColumn(),
});

// Tenant-scoped system prompt injection (append/override). One row per
// tenant; `global` NULL means never configured, distinct from an explicit
// disabled setting. Providers/models/combos/aliases are JSON object maps
// keyed by providerId, `providerId::modelId`, combo name, and alias name
// respectively — see `src/console/system-prompt/contracts.ts` for the value
// shapes and the resolution rules implemented by the dispatch-path transform.
export const tenantSystemPrompts = pgTable("tenant_system_prompts", {
  tenantId: tenantRefPrimaryKey(),
  global: jsonb("global").$type<import("../console/system-prompt/contracts").ScopePromptRef | null>(),
  presets: jsonb("presets")
    .notNull()
    .default({})
    .$type<Record<string, import("../console/system-prompt/contracts").SystemPromptPreset>>(),
  providers: jsonb("providers")
    .notNull()
    .default({})
    .$type<Record<string, import("../console/system-prompt/contracts").ScopePromptRef>>(),
  models: jsonb("models")
    .notNull()
    .default({})
    .$type<Record<string, import("../console/system-prompt/contracts").ScopePromptRef>>(),
  combos: jsonb("combos")
    .notNull()
    .default({})
    .$type<Record<string, import("../console/system-prompt/contracts").ScopePromptRef>>(),
  aliases: jsonb("aliases")
    .notNull()
    .default({})
    .$type<Record<string, import("../console/system-prompt/contracts").ScopePromptRef>>(),
  updatedAt: updatedAtColumn(),
});

// InferHub `config_read` key. One row for the whole deployment.
//
// Deliberately NOT `provider_accounts.auth_state`: that field is documented as
// per-account *non-secret* upstream config and travels with the account through
// backup/restore, so a credential stored there is copied around and readable by
// anything that reads accounts. This key is a secret and gets its own encrypted
// row, unreachable from the account paths.
export const inferhubConfigKeys = pgTable("inferhub_config_keys", {
  id: text("id").primaryKey(),
  /** `encryptCredential` output — never plaintext, never returned by an API. */
  ciphertext: bytea("ciphertext").notNull(),
  /** Hash only, for "did it change" checks. Not used to verify the key. */
  fingerprint: text("fingerprint").notNull(),
  updatedAt: updatedAtColumn(),
});


// CLI Tools (CLI tool configuration): per-tenant mapping table that lets a coding-agent
// slot (e.g. Claude Code's "opus" slot) target a specific Cartethyia model. Rows
// are opaque strings — validation happens at the API boundary against the
// tool registry, not in Postgres.
export const cliToolMappings = pgTable(
  "cli_tool_mappings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantRefRequired(),
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references((): AnyPgColumn => apiKeys.id, { onDelete: "cascade" }),
    toolId: text("tool_id").notNull(),
    slotKey: text("slot_key").notNull(),
    sourceModel: text("source_model").notNull(),
    targetModel: text("target_model").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex("cli_tool_mappings_key").on(
      table.tenantId,
      table.toolId,
      table.apiKeyId,
      table.slotKey,
    ),
  ],
);


// Per-(tenant, tool, api_key) settings: whether mappings are active and which
// mode the tool is configured for. Primary key is the composite of all three.
export const cliToolSettings = pgTable(
  "cli_tool_settings",
  {
    tenantId: tenantRefRequired(),
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references((): AnyPgColumn => apiKeys.id, { onDelete: "cascade" }),
    toolId: text("tool_id").notNull(),
    mappingsEnabled: boolean("mappings_enabled").notNull().default(false),
    mode: text("mode").notNull().default("remote"),
    updatedAt: updatedAtColumn(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.toolId, table.apiKeyId] })],
);


// Metadata-only request telemetry. Retention is configured independently of
// payload capture (`CARTETHYIA_TELEMETRY_RETENTION_DAYS`, default 30 days).
// No prompt text, raw body, API key, encrypted-reasoning payload, or generic
// `payload` column — the schema structurally prevents those fields.
// Correlation columns intentionally have no catalog foreign keys, so a
// telemetry write never depends on provider-row lifetime.
export const telemetryEvents = pgTable(
  "telemetry_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: createdAtColumn(),
    tenantId: tenantRefRequired(),
    requestId: uuid("request_id").notNull(),
    sourceSurface: telemetrySourceSurface("source_surface"),
    requestedModel: text("requested_model"),
    /**
     * Canonical client name derived from `user_agent` at ingestion
     * (`clientNameFromUserAgent`). Stamped once at write time so client
     * breakdowns group in SQL; the raw `user_agent` stays for detail.
     */
    clientName: text("client_name"),
    /**
     * The `model` the upstream put in its own response, verbatim.
     *
     * Separate from `requested_model` because they answer different questions:
     * one is what the client asked for, the other is what the provider said it
     * ran. A provider that answers `muse-spark` as `deepseek-v4.1-flash` is
     * telling the operator something, and overwriting one with the other would
     * erase it. NULL when the response carried no model.
     */
    reportedModel: text("reported_model"),
    /** Canonical reasoning effort the client asked for; NULL when it asked for none. */
    requestedEffort: text("requested_effort"),
    providerId: text("provider_id"),
    accountId: uuid("account_id"),
    networkPoolId: uuid("network_pool_id"),
    endpoint: text("endpoint"),
    apiKeyId: uuid("api_key_id"),
    /**
     * The share-template key this event belongs to (the template itself, or
     * the parent of the child key that carried the request). Denormalized at
     * write time so family rollups survive the key row being deleted — an
     * `EXISTS` join against `api_keys` tied history to key lifetime. NULL for
     * requests that ran under no share template.
     */
    familyTemplateKeyId: uuid("family_template_key_id"),
    userAgent: text("user_agent"),
    clientIp: text("client_ip"),
    latencyMs: integer("latency_ms"),
    ttfbMs: integer("ttfb_ms"),
    stream: boolean("stream"),
    status: telemetryStatus("status"),
    /**
     * HTTP status the client actually received. The `status` enum is the
     * internal terminal state (`completed`/`failed`/…), which collapses every
     * failure to one bucket; this column keeps the wire code, so a 503
     * admission rejection stays distinguishable from a 500 upstream failure
     * in the Usage status breakdown. NULL on rows written before the column.
     */
    httpStatus: integer("http_status"),
    /**
     * Which layer produced the failure: the gateway itself, the upstream
     * provider, or the network in between. Recorded beside `error_category`
     * because the category alone cannot separate them — `invalid_request` is
     * both "the caller sent a bad body" (ours) and "the upstream rejected the
     * body" (theirs), and an operator triaging a failure needs to know which.
     */
    errorOrigin: text("error_origin"),
    errorCategory: text("error_category"),
    inputTokens: integer("input_tokens"),
    cachedInputTokens: integer("cached_input_tokens"),
    outputTokens: integer("output_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 12, scale: 6 }),
    /** Provider-billed credits (Tencent buddy-meter `credit`); NULL when unreported. */
    creditUsed: numeric("credit_used", { precision: 12, scale: 4 }),
    /**
     * Gateway-side time before the upstream dispatch began: routing,
     * credential lease, and request preparation. `ttfbMs` is measured from
     * the dispatch start, so this is the overhead the client waited on before
     * the provider was even called.
     */
    resolveMs: integer("resolve_ms"),
    tokensPerSec: numeric("tokens_per_sec", { precision: 10, scale: 2 }),
    // Absolute epoch-millisecond event timestamps (~1.8e12) overflow integer
    // (int4): completed requests carrying observed stream timings failed
    // their telemetry insert and vanished from the console. bigint "number"
    // mode is safe here — epoch millis stay far below MAX_SAFE_INTEGER —
    // and keeps the columns JSON-safe like the token-budget bigints above.
    firstContentDeltaAtMs: bigint("first_content_delta_at_ms", { mode: "number" }),
    lastEventAtMs: bigint("last_event_at_ms", { mode: "number" }),
    /**
     * Why this request's drawer payloads were not captured, or `captured` when
     * they were. Remote-diagnosis column: the drawer reads empty for reasons
     * that are invisible from the client — the tenant's capture mode, a missing
     * tenant, a non-terminal attempt — and without this an operator could not
     * tell "not configured" from "broken".
     */
    payloadCaptureState: text("payload_capture_state"),
  },
  (table) => [
    index("telemetry_events_created_at_idx").on(table.createdAt),
    // Keyset pagination, newest-first: `(created_at, id)` DESC breaks ties
    // deterministically (created_at is second-resolution), so a cursor on the
    // pair never skips or repeats rows at a boundary. Replaces the plain
    // `(tenant_id, created_at)` index, which could not break ties.
    index("telemetry_events_tenant_created_id_idx").on(
      table.tenantId,
      desc(table.createdAt),
      desc(table.id),
    ),
    /**
     * Cross-process idempotency boundary: one terminal event per
     * (tenant, request). Retried drains and cross-process races converge to
     * one row (and one usage charge) via `ON CONFLICT DO NOTHING`.
     */
    uniqueIndex("telemetry_events_tenant_request_uidx").on(
      table.tenantId,
      table.requestId,
    ),
    // Usage status breakdown: equality on `http_status`, keyset range+order.
    index("telemetry_events_tenant_http_created_id_idx").on(
      table.tenantId,
      table.httpStatus,
      desc(table.createdAt),
      desc(table.id),
    ),
    // Per-key family spend: equality on `api_key_id`, keyset range+order.
    index("telemetry_events_tenant_api_key_created_id_idx").on(
      table.tenantId,
      table.apiKeyId,
      desc(table.createdAt),
      desc(table.id),
    ),
    // Share-family rollup: equality on the denormalized template, keyset
    // range+order. Backs both the family totals and the hourly chart reads.
    index("telemetry_events_tenant_family_created_id_idx").on(
      table.tenantId,
      table.familyTemplateKeyId,
      desc(table.createdAt),
      desc(table.id),
    ),
    index("telemetry_events_request_id_idx").on(table.requestId),
    index("telemetry_events_tenant_account_created_idx").on(
      table.tenantId,
      table.accountId,
      table.createdAt,
    ),
    /**
     * Serves the public share page's per-key aggregate (`share-usage.ts`):
     * equality on `api_key_id`, range and aggregate on `created_at`. Without
     * it every share render scanned the largest table in the schema.
     */
    index("telemetry_events_api_key_created_idx").on(table.apiKeyId, table.createdAt),
  ],
);

/**
 * Backfill/reconciliation checkpoint for `carte telemetry reconcile`.
 *
 * One row per job name. The checkpoint (file_name, byte_offset) commits in
 * the same transaction as each backfill batch, so a crash resumes from the
 * last committed offset. The lease columns let exactly one worker run the
 * job: a second worker is rejected until the lease expires.
 */
export const telemetryReconciliationState = pgTable(
  "telemetry_reconciliation_state",
  {
    jobName: text("job_name").primaryKey(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    fileName: text("file_name").notNull().default(""),
    byteOffset: bigint("byte_offset", { mode: "number" }).notNull().default(0),
    filesCompleted: bigint("files_completed", { mode: "number" }).default(0),
    eventsExamined: bigint("events_examined", { mode: "number" }).default(0),
    eventsInserted: bigint("events_inserted", { mode: "number" }).default(0),
    conflicts: bigint("conflicts", { mode: "number" }).default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("telemetry_reconciliation_state_offset_nonneg", sql`${table.byteOffset} >= 0`),
    check("telemetry_reconciliation_state_files_nonneg", sql`${table.filesCompleted} >= 0`),
    check("telemetry_reconciliation_state_examined_nonneg", sql`${table.eventsExamined} >= 0`),
    check("telemetry_reconciliation_state_inserted_nonneg", sql`${table.eventsInserted} >= 0`),
    check("telemetry_reconciliation_state_conflicts_nonneg", sql`${table.conflicts} >= 0`),
  ],
);

/** Durable aggregates retained after metadata telemetry expires. */
export const TELEMETRY_USAGE_IDENTITY_TYPES = ["account", "api_key"] as const;
export type TelemetryUsageIdentityType = (typeof TELEMETRY_USAGE_IDENTITY_TYPES)[number];

export const telemetryUsageTotals = pgTable(
  "telemetry_usage_totals",
  {
    tenantId: tenantRefRequired(),
    identityType: text("identity_type").$type<TelemetryUsageIdentityType>().notNull(),
    entityId: uuid("entity_id").notNull(),
    /**
     * For `api_key` identities, the share-template key this key belongs to
     * (the template itself, or the parent of a minted child). Denormalized so
     * family reads do not depend on the key row surviving; NULL for `account`
     * identities and for keys outside a share family.
     */
    familyTemplateKeyId: uuid("family_template_key_id"),
    requests: bigint("requests", { mode: "number" }).notNull().default(0),
    errors: bigint("errors", { mode: "number" }).notNull().default(0),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    primaryKey({
      name: "telemetry_usage_totals_identity_pk",
      columns: [table.tenantId, table.identityType, table.entityId],
    }),
    check(
      "telemetry_usage_totals_identity_type_check",
      sql`${table.identityType} IN ('account', 'api_key')`,
    ),
    index("telemetry_usage_totals_tenant_family_idx").on(
      table.tenantId,
      table.familyTemplateKeyId,
    ),
  ],
);


export const telemetryPayloads = pgTable(
  "telemetry_payloads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantRefRequired(),
    requestId: uuid("request_id"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /**
     * Typed index into the on-disk frame store. Prompt/response bodies live
     * only in the frame file these columns name — never in Postgres, which is
     * why this table carries no body column to write one into by accident.
     */
    storage: text("storage").notNull(),
    file: text("file").notNull(),
    offset: integer("offset").notNull(),
    length: integer("length").notNull(),
    checksum: text("checksum").notNull(),
    version: integer("version").notNull(),
    /**
     * Which of the four payload stages were captured, as a bitmask. The Usage
     * list shows one icon per stage; learning presence from the frame would
     * cost one inflate per row, so the writer records it here and the list
     * reads it off the indexed row.
     *
     * Bits: 1=request, 2=provider_request, 4=provider_response,
     * 8=client_response. Nullable: NULL renders as all icons greyed rather
     * than inventing presence.
     */
    stages: integer("stages"),
  },
  (table) => [
    index("telemetry_payloads_request_id_idx").on(table.requestId),
    index("telemetry_payloads_tenant_request_idx").on(table.tenantId, table.requestId),
    index("telemetry_payloads_expires_idx").on(table.expiresAt),
    check("telemetry_payloads_storage_check", sql`${table.storage} = 'jsonl-file'`),
    check("telemetry_payloads_version_check", sql`${table.version} = 1`),
    check("telemetry_payloads_offset_check", sql`${table.offset} >= 0`),
    check("telemetry_payloads_length_check", sql`${table.length} > 0`),
  ],
);



// Daily check-in ledger: one row per (account, calendar day) once the sweep has
// attempted that account's claim.
//
// The day-scoped composite PK is the claim guard — an insert that conflicts is
// exactly the "already settled today" answer — so it replaces the Redis
// `SET NX EX` the Lite backend never had. The console reads the same table to
// answer "was this attempted today", which is what makes the Quota page show
// the real state instead of a permanent "Check-in due" when Redis is absent.
export const dailyCheckinLedger = pgTable(
  "daily_checkin_ledger",
  {
    dayKey: text("day_key").notNull(),
    accountId: uuid("account_id").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.dayKey, table.accountId] }),
  ],
);


/**
 * Per-day, per-model credit deductions the buddy billing meter reported.
 *
 * A snapshot, not a ledger: the upstream is the source of truth and answers the
 * whole window on every call, so a row is upserted rather than appended. What it
 * buys is that the console renders a *stored* figure — without it every page
 * open would re-hit the billing endpoint for every account, and a failed read
 * would show nothing at all instead of the last number obtained.
 *
 * Keyed (account, day, model): one row per bucket, and the conflict target is
 * what makes the write idempotent across passes.
 */
export const buddyUsageSnapshots = pgTable(
  "buddy_usage_snapshots",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => providerAccounts.id, { onDelete: "cascade" }),
    /** Calendar day the requests were metered on, `YYYY-MM-DD`. */
    dayKey: text("day_key").notNull(),
    model: text("model").notNull(),
    /** Credits deducted across every request in this bucket. */
    credit: numeric("credit", { precision: 14, scale: 4 }).notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.dayKey, table.model] }),
    index("buddy_usage_snapshots_day_idx").on(table.dayKey),
  ],
);

/**
 * One row per (day, account, growth task) once that day's claim was attempted.
 *
 * The composite PK is the idempotency guard: an insert that conflicts is
 * exactly the "already settled today" answer, which is what stops a sweep from
 * re-POSTing a claim on every pass. Same shape as `daily_checkin_ledger`
 * because it is the same problem — one claim per account per day — widened by
 * the task name now that there is more than one thing to claim.
 */
export const buddyTaskLedger = pgTable(
  "buddy_task_ledger",
  {
    dayKey: text("day_key").notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => providerAccounts.id, { onDelete: "cascade" }),
    task: text("task").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.dayKey, table.accountId, table.task] }),
    index("buddy_task_ledger_account_idx").on(table.accountId),
  ],
);
