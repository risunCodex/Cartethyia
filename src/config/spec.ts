/**
 * Spec-driven configuration reader shared by the `src/config/` domain modules.
 *
 * `CONFIG_SPEC` is the canonical declaration of every environment variable
 * `src/config/` reads: name, kind, default, and bounds in one place. The
 * resolvers in the sibling domain modules are thin readers over it, so a new
 * knob cannot be added without declaring a row here plus a `.env.example`
 * line. Bounds are enforced on read so a malformed operator value throws at
 * the boundary instead of silently coercing.
 *
 * Module-specific environment reads that only affect a single subsystem (e.g.
 * logger level, telemetry payload storage, Postgres pool tuning) still live
 * next to their consumer. No I/O, no caching — readers are pure with respect
 * to `process.env` at call time.
 */

/** Default directory for the built dashboard static assets. */
const DEFAULT_DASHBOARD_DIST = "./dist/dashboard";
/** Default upstream client version host for Kimi's OAuth origin. */
const DEFAULT_KIMI_OAUTH_HOST = "https://auth.kimi.com";
/** Base for Kimi Code's quota/billing surface; the usage path joins on this. */
const DEFAULT_KIMI_QUOTA_BASE_URL = "https://api.kimi.com/coding/v1";

// ─── Config spec ────────────────────────────────────────────────────────────

interface IntConfigEntry {
  readonly kind: "int";
  readonly default: number;
  readonly min: number;
  readonly max: number;
}

interface TextConfigEntry {
  readonly kind: "text";
  readonly default: string;
}

/** Absent means "no value"; an empty/whitespace value also reads as absent. */
interface OptionalTextConfigEntry {
  readonly kind: "optional-text";
}

/**
 * Absent or empty means "unset" — distinct from an explicit value, because
 * consumers apply their own fallback (cgroup detection, egress default) rather
 * than a fixed default here.
 */
interface OptionalIntConfigEntry {
  readonly kind: "optional-int";
  readonly min: number;
  readonly max: number;
}

interface RequiredTextConfigEntry {
  readonly kind: "required";
  readonly error: string;
}

/** Enabled unless the literal string `"false"` is set. */
interface FlagConfigEntry {
  readonly kind: "flag";
}

/** Comma-separated list; an empty result reads as absent. */
interface ListConfigEntry {
  readonly kind: "list";
}

export type ConfigEntry =
  | IntConfigEntry
  | TextConfigEntry
  | OptionalTextConfigEntry
  | OptionalIntConfigEntry
  | RequiredTextConfigEntry
  | FlagConfigEntry
  | ListConfigEntry;

/**
 * The single declaration of every environment variable `src/config/` reads.
 *
 * Adding a knob means adding a row here plus a `.env.example` line. Bounds are
 * enforced on read so a malformed operator value throws at the boundary
 * instead of silently coercing.
 */
export const CONFIG_SPEC = {
  // HTTP listener + dashboard runtime
  PORT: { kind: "int", default: 12_800, min: 1, max: 65_535 },
  DASHBOARD_DIST: { kind: "text", default: DEFAULT_DASHBOARD_DIST },
  CARTETHYIA_API_KEY: { kind: "optional-text" },
  CARTETHYIA_SERVER_MAX_BODY_BYTES: {
    kind: "int",
    // A 1M-token context is roughly 4+ MB of text (Qoder gRPC/legacy paths
    // accept it), so 16 MB admits every real request while bounding the
    // worst-case hold. How many may be in flight is admission's job, so an
    // operator with even larger payloads raises this and sets the ceiling in
    // Settings.
    default: 16 * 1024 * 1024,
    min: 1024,
    max: Number.MAX_SAFE_INTEGER,
  },
  CARTETHYIA_SERVER_IDLE_TIMEOUT: { kind: "int", default: 60, min: 0, max: 86_400 },

  // Graceful-shutdown drain: how long in-flight requests may finish naturally
  // before the drain aborts the stragglers. Sized above the common case (a
  // typical response) but below the stream stall bound so a wedged stream is
  // still cut within the process budget.
  CARTETHYIA_SHUTDOWN_DRAIN_WINDOW_MS: {
    kind: "int",
    default: 20_000,
    min: 0,
    max: 600_000,
  },
  // Optional ceiling on in-flight requests per process. Left unset, the limit
  // is derived from the memory limit and the body ceiling (see
  // config/resources.ts): 2 GiB/4 MiB → 64, 512 MiB/4 MiB → 16, 256 MiB/16 MiB
  // → 2. Set it to admit more than memory alone would allow — which is the
  // operator's call, and is reported rather than corrected — or less, to keep
  // a slow upstream from being handed more concurrency than it can serve.
  // Optional-int, not int-with-a-zero-default: "unset" and "explicitly zero"
  // must not be the same thing. Zero is not a valid ceiling, so a default of 0
  // would need a second sentinel to mean "derive".
  // Slack above each key's concurrency limit. Effective ceiling is
  // limit + tolerance; only requests past it are refused.
  CARTETHYIA_CONCURRENCY_TOLERANCE: { kind: "optional-int", min: 0, max: 1024 },
  // How many gateway processes serve this deployment, and which one this is.
  // Count > 1 requires Linux, CARTETHYIA_DB_MODE=full, and a REACHABLE Redis —
  // checked at boot, because a half-configured multi-process deploy starts
  // fine and then enforces every per-key limit N times over. Lite stays
  // single-process: two processes on one SQLite file corrupt it.
  CARTETHYIA_PROCESS_COUNT: { kind: "int", default: 1, min: 1, max: 16 },
  // Which process this is (0 – count-1). Mandatory when count > 1: a process
  // that does not know its index cannot own a shard of anything.
  CARTETHYIA_PROCESS_INDEX: { kind: "int", default: 0, min: 0, max: 15 },
  // Optional secret for the operator drain endpoint (`POST /admin/drain`). When
  // set, a process can be stopped gracefully on platforms where a catchable
  // signal cannot be delivered to it (notably Windows, where `process.kill` of
  // a console-less process runs no JS handler). The endpoint additionally
  // requires a loopback peer and a timing-safe token match; unset = the route
  // does not exist.
  CARTETHYIA_DRAIN_TOKEN: { kind: "optional-text" },
  CARTETHYIA_INSTALL_ID_DIR: { kind: "optional-text" },

  // Network policy (trusted proxy + SSRF)
  TRUSTED_PROXY_CIDRS: { kind: "list" },
  CARTETHYIA_ALLOW_PRIVATE_UPSTREAMS: { kind: "flag" },
  CARTETHYIA_ALLOWED_NETWORKS: { kind: "list" },
  CARTETHYIA_MAX_REDIRECTS: { kind: "optional-int", min: 0, max: 10 },

  // Runtime memory
  CARTETHYIA_MEMORY_LIMIT_BYTES: {
    kind: "optional-int",
    min: 1,
    max: Number.MAX_SAFE_INTEGER,
  },
  // Opt-in forced garbage collection under memory pressure. Off by default:
  // see `observability/runtime-metrics.ts` — a forced collection is not
  // reclamation, and a collection that runs while requests are in flight adds
  // a latency spike. This gates the pressure path only; idle reclaim runs
  // unconditionally, because reclaiming when nothing is in flight stalls
  // nothing.
  CARTETHYIA_FORCED_GC: { kind: "flag" },
  // How often runtime gauges (memory + bounded-collection sizes) are sampled.
  CARTETHYIA_RUNTIME_METRICS_INTERVAL_MS: {
    kind: "int",
    default: 30_000,
    min: 1_000,
    max: 300_000,
  },
  /**
   * Periodic maintenance tasks switched off entirely, by name. A small
   * deployment that does not need live quota or version polling can cut the
   * heaviest sweeps here instead of carrying one flag per task.
   */
  CARTETHYIA_DISABLED_TASKS: { kind: "list" },

  /**
   * How long a day's telemetry is kept, in days.
   *
   * Whole raw event files past this age are removed. No summary or compacted
   * form replaces the individual requests.
   *
   * This is the knob that decides how long the request list, per-request
   * filters, and the detail drawer stay complete.
   */
  CARTETHYIA_TELEMETRY_RETENTION_DAYS: { kind: "int", default: 30, min: 3, max: 365 },
  CARTETHYIA_TELEMETRY_PAYLOAD_MAX_BYTES: {
    kind: "int",
    default: 16 * 1024 * 1024,
    min: 1 * 1024 * 1024,
    max: 16 * 1024 * 1024,
  },
  // Input-token accounting for usage display. Providers disagree on whether
  // `input_tokens` already includes cached tokens: OpenAI/DeepSeek report the
  // inclusive total with a cached subset, while Anthropic reports fresh-only
  // with cache reads separate. `inclusive` (default) folds cache into input so
  // every provider reads alike — IN is always the whole prompt and CACHED its
  // subset. `as-is` keeps the raw upstream semantics.
  CARTETHYIA_USAGE_INPUT_MODE: { kind: "text", default: "inclusive" },

  // Upstream request timeout + retry backoff
  //
  // Strictly under 90s: a client whose own deadline is 90s must never be
  // waiting on a gateway that is still holding a request open past it, and a
  // provider that has not answered within 75s is not answering — the request
  // is queued upstream or the egress is stuck, and the honest move is to fail
  // over to another account rather than burn the caller's whole budget on one.
  // 120s outlived the clients that call this, which cap lower.
  CARTETHYIA_UPSTREAM_TIMEOUT_MS: { kind: "int", default: 75_000, min: 5_000, max: 600_000 },
  CARTETHYIA_STREAM_STALL_TIMEOUT_MS: {
    kind: "int",
    default: 360_000,
    min: 60_000,
    max: 600_000,
  },
  CARTETHYIA_STREAM_FIRST_CHUNK_TIMEOUT_MS: {
    kind: "int",
    default: 200_000,
    min: 30_000,
    max: 300_000,
  },
  CARTETHYIA_FALLBACK_RETRY_BASE_MS: { kind: "int", default: 100, min: 0, max: 60_000 },
  CARTETHYIA_FALLBACK_RETRY_CAP_MS: { kind: "int", default: 2_000, min: 0, max: 300_000 },
  CARTETHYIA_ROUTE_MAX_ATTEMPTS: { kind: "int", default: 8, min: 1, max: 64 },
  /**
   * Unified routing decision engine (routing/quota/health unification).
   *
   * Only the literal `true` enables it. When true, the routing engine
   * evaluates a normalized quota/plan fact per candidate: known-exhausted or
   * below-floor accounts are proactively excluded before dispatch (model-aware
   * window matching), unknown quota is an explicit lower-rank state instead of
   * implicit permissiveness, and the plan gate is a first-class reason. When
   * false (default), legacy permissive behavior is preserved unchanged.
   * Staged rollout switch — no one-shot unflagged cutover.
   */
  CARTETHYIA_UNIFIED_ROUTING_DECISION: { kind: "text", default: "false" },

  // Account/pool health cooldown delays. Each is the fallback used when the
  // upstream error states no explicit reset window; an upstream
  // `Retry-After`/reset header or message always wins over these.
  CARTETHYIA_ACCOUNT_RATE_LIMIT_COOLDOWN_MS: { kind: "int", default: 900_000, min: 0, max: 86_400_000 },
  CARTETHYIA_ACCOUNT_QUOTA_COOLDOWN_MS: { kind: "int", default: 3_600_000, min: 0, max: 86_400_000 },
  CARTETHYIA_ACCOUNT_MODEL_CAPACITY_COOLDOWN_MS: { kind: "int", default: 120_000, min: 0, max: 86_400_000 },
  CARTETHYIA_ACCOUNT_TRANSIENT_COOLDOWN_MS: { kind: "int", default: 30_000, min: 0, max: 86_400_000 },
  /**
   * An unmapped upstream failure cools the account down for 15 minutes.
   *
   * A shorter window puts the account straight back into rotation and re-dials
   * an upstream that has just answered something this gateway does not
   * understand — so the same unknown error is retried every minute, and an
   * account that is actually broken contributes a steady stream of failed
   * attempts instead of one. Fifteen minutes is long enough for a transient
   * provider condition to clear on its own and short enough that no operator
   * action is needed to recover it. It is still a cooldown with a deadline,
   * never `disabled`, so nothing here can strand an account.
   */
  CARTETHYIA_ACCOUNT_UNCLASSIFIED_COOLDOWN_MS: {
    kind: "int",
    default: 900_000,
    min: 0,
    max: 86_400_000,
  },
  CARTETHYIA_ACCOUNT_COOLDOWN_ESCALATION_MAX_MS: { kind: "int", default: 3_600_000, min: 0, max: 86_400_000 },
  CARTETHYIA_POOL_COOLDOWN_MS: { kind: "int", default: 120_000, min: 0, max: 86_400_000 },
  /**
   * A provider-scoped egress cooldown (a 429 the pool itself earned) when the
   * upstream named no window. Default 1h: an egress that exhausted a
   * request-counted allowance stays refused long past minute 15, and a short
   * default sent the pool back into rotation to be refused again.
   */
  CARTETHYIA_POOL_PROVIDER_RATE_LIMIT_COOLDOWN_MS: {
    kind: "int",
    default: 3_600_000,
    min: 0,
    max: 86_400_000,
  },
  CARTETHYIA_ACCOUNT_AUTH_REJECTED_COOLDOWN_MS: { kind: "int", default: 300_000, min: 0, max: 86_400_000 },
  CARTETHYIA_ACCOUNT_POLICY_BLOCK_COOLDOWN_MS: { kind: "int", default: 300_000, min: 0, max: 86_400_000 },
  CARTETHYIA_ACCOUNT_DISABLED_RECOVERY_MS: { kind: "int", default: 86_400_000, min: 0, max: 604_800_000 },
  /**
   * Routing reserve: an account whose remaining quota fraction falls at or
   * below this percent is demoted behind non-reserve siblings during ordering
   * (it is still eligible and still routed — a reserve is a preference, never
   * an exclusion). 0 disables reserve demotion for every account.
   */
  CARTETHYIA_ACCOUNT_RESERVE_PCT: { kind: "int", default: 20, min: 0, max: 100 },
  /**
   * Session stickiness warm window (milliseconds). Within this window after an
   * account last served a session id, routing prefers that account when it is
   * still eligible — prompt-cache warmth is worth more than perfect load
   * balance. Past the window, the sticky account is only an ordering hint.
   * 0 disables stickiness.
   */
  CARTETHYIA_ROUTING_STICKY_WARM_MS: { kind: "int", default: 300_000, min: 0, max: 86_400_000 },
  /**
   * Hard ceiling on distinct session ids whose sticky state is retained in
   * memory per provider (LRU). Evicted sessions simply lose their preference.
   */
  CARTETHYIA_ROUTING_STICKY_MAX_SESSIONS: { kind: "int", default: 256, min: 1, max: 10_000 },

  // Proxy pool agents
  CARTETHYIA_PROXY_MAX_SOCKETS: { kind: "int", default: 100, min: 1, max: 100_000 },
  CARTETHYIA_PROXY_MAX_FREE_SOCKETS: { kind: "int", default: 20, min: 0, max: 100_000 },

  // Security (encryption key, public origin, abuse ceiling)
  IP_RATE_MAX_PER_WINDOW: { kind: "int", default: 540, min: 1, max: Number.MAX_SAFE_INTEGER },
  CARTETHYIA_ENCRYPTION_KEY: {
    kind: "required",
    error:
      "CARTETHYIA_ENCRYPTION_KEY is required to encrypt credentials and hash API keys",
  },
  CARTETHYIA_PUBLIC_ORIGIN: {
    kind: "required",
    error:
      "CARTETHYIA_PUBLIC_ORIGIN is required to build OAuth redirect URIs (e.g. https://cartethyia.example.com)",
  },

  // Provider OAuth hosts
  CARTETHYIA_KIMI_OAUTH_HOST: { kind: "text", default: DEFAULT_KIMI_OAUTH_HOST },
  /**
   * Loopback port the browser-OAuth callback listener binds.
   *
   * Configurable because the default is a fixed number: a busy port would strand
   * the operator, since the login could not start and there would be no way to
   * move it. Codex's authorization server still expects 59653, so changing this
   * only helps the providers whose redirect URI is not allowlisted upstream.
   */
  CARTETHYIA_OAUTH_CALLBACK_PORT: { kind: "int", default: 59_653, min: 1_024, max: 65_535 },
  /**
   * Kimi Code quota/billing base. The `/usages` path joins on this, so the
   * default includes the `/v1` segment the bundled provider metadata implies.
   */
  CARTETHYIA_KIMI_QUOTA_BASE_URL: { kind: "text", default: DEFAULT_KIMI_QUOTA_BASE_URL },
  /**
   * GitHub Enterprise domain for the Copilot device login, e.g.
   * `company.ghe.com`. Empty (the default) means github.com. GitHub Enterprise
   * serves the device flow and the token-mint endpoint from its own domain, so
   * an operator on one has no other way to point the login at it.
   */
  CARTETHYIA_GITHUB_ENTERPRISE_DOMAIN: { kind: "text", default: "" },
  /**
   * Which wire identity the GitHub Copilot Auto/chat path presents to the
   * upstream:
   *
   * - `opencode-copilot` (default): the long-lived GitHub OAuth token + minimal
   *   OpenCode headers. One token, no mint step, no short-lived minted-token
   *   expiry. This is the most stable in practice.
   * - `vscode-client-real`: a freshly minted Copilot token + the full VS Code
   *   reference headers. Matches the VS Code client exactly, but requires the
   *   minted token (expires ~25 min) and the reference identity.
   */
  CARTETHYIA_GITHUB_COPILOT_MODE: { kind: "text", default: "opencode-copilot" },
  // Only the literal true opts active ZCode accounts into daily gift claims.
  CARTETHYIA_ZCODE_AUTO_CLAIM: { kind: "text", default: "false" },
  /**
   * Free-tier OpenCode ids the listing still advertises but upstream refuses.
   * Replaces the bundled list outright; the single token `none` trusts the
   * listing completely.
   *
   * The bundled ids were measured, not declared — upstream can start serving
   * a refused id or start refusing a served one at any time, and either way
   * the correct answer stopped being the one compiled in. This is the escape
   * hatch that needs no deploy.
   */
  CARTETHYIA_OPENCODE_UNAVAILABLE_FREE: { kind: "list" },
} as const satisfies Readonly<Record<string, ConfigEntry>>;

// ─── Spec readers ───────────────────────────────────────────────────────────

/** Reads a bounded integer, throwing on a malformed or out-of-range value. */
export function readInt(name: string, entry: IntConfigEntry): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return entry.default;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < entry.min || value > entry.max) {
    throw new Error(`${name} must be an integer between ${entry.min} and ${entry.max}`);
  }
  return value;
}

/** Reads a string with a fallback, treating an empty value as absent. */
export function readText(name: string, entry: TextConfigEntry): string {
  const raw = process.env[name]?.trim();
  return raw && raw.length > 0 ? raw : entry.default;
}

/** Reads an optional string; empty or whitespace reads as absent. */
export function readOptionalText(name: string, entry: ConfigEntry): string | undefined {
  if (entry.kind !== "optional-text") {
    throw new Error(`${name} must be declared optional-text in CONFIG_SPEC`);
  }
  const raw = process.env[name]?.trim();
  return raw && raw.length > 0 ? raw : undefined;
}

/** Reads an optional bounded integer; absent or empty reads as `undefined`. */
export function readOptionalInt(name: string, entry: OptionalIntConfigEntry): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < entry.min || value > entry.max) {
    throw new Error(`${name} must be an integer between ${entry.min} and ${entry.max}`);
  }
  return value;
}

/** Reads a required string, throwing with the entry's documented message. */
export function readRequired(name: string, entry: RequiredTextConfigEntry): string {
  const raw = process.env[name];
  if (!raw) throw new Error(entry.error);
  return raw;
}

/** Reads a flag: enabled unless the literal `"false"` is set. */
export function readFlag(name: string, entry: ConfigEntry): boolean {
  if (entry.kind !== "flag") {
    throw new Error(`${name} must be declared flag in CONFIG_SPEC`);
  }
  return process.env[name] !== "false";
}

/** Reads a comma-separated list, dropping empty entries. */
export function readList(name: string, entry: ConfigEntry): readonly string[] | undefined {
  if (entry.kind !== "list") {
    throw new Error(`${name} must be declared list in CONFIG_SPEC`);
  }
  const entries = process.env[name]
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return entries && entries.length > 0 ? entries : undefined;
}
