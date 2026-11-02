// Routing contracts and snapshots.
import { GatewayError } from "../../protocol/gateway-error";
import { type ServiceKind, type WireFamily } from "../../protocol/canonical-model";
import type { CallerIdentity } from "../../security/access-control";

export type { CallerIdentity };


export type RoutingRevision = number;

export type CapabilityProfile = Readonly<Record<string, boolean>>;

export interface RouteCandidate {
  readonly provider_id: string;
  readonly model_id: string;
  readonly wire_family: WireFamily;
  /**
   * Protocol shape of the model. `llm` (the default) flows through the
   * canonical surface pipeline; a non-`llm` model is dispatched by its native
   * route handler, which reads `endpoint` directly and never encodes a
   * canonical request. Absent means `llm` — every pre-existing row.
   */
  readonly service_kind?: ServiceKind;
  readonly endpoint: string;
  /** Catalog output ceiling. Absent means the wire default still applies. */
  readonly output_limit?: number | null;
  readonly capability_profile: CapabilityProfile;
  /** Route-selected User-Agent fallback; provider-supplied identities remain authoritative. */
  readonly user_agent?: string;
  readonly max_inflight?: number;
  readonly provider_account_id?: string;
  /** Cooldown class: `hard` = excluded until the deadline; `soft` = deprioritized. */
  readonly cooldown_kind?: "hard" | "soft";
  /** Operator-facing label of `provider_account_id` (never the secret), for
   * the Console Log detail line — logs must show a name, not a bare id. */
  readonly provider_account_label?: string;
  /** Every active pool eligible for automatic per-request selection
   * (`NetworkPoolSelector.tryAcquireAvailablePool`) — the dispatch handler
   * picks the least-loaded/non-cooldown pool at request time; there is no
   * admin-pinned single pool. Absent/empty when the provider bypasses the
   * proxy pool entirely (direct dispatch). */
  readonly network_pool_ids?: readonly string[];
  /** True when routing requires a pool even if health filtering leaves none eligible. */
  readonly network_pool_required?: boolean;
  /** `network_pool_ids[i]` → its configured max concurrency, for the
   * selection algorithm's overflow decision. */
  readonly network_pool_limits?: Readonly<Record<string, number>>;
  /** `network_pool_ids[i]` → its routing weight (100 = neutral). Effective
   * capacity scales as `limit * weight / 100`; weight ≤ 0 takes the pool
   * out of selection. */
  readonly network_pool_weights?: Readonly<Record<string, number>>;
  /** Selection strategy for the tenant that owns `network_pool_ids`;
   * `tenantId` names that pool-owning tenant (settings owner and rotation
   * cursor key). Absent = `least_loaded`. */
  readonly network_pool_routing?: PoolRoutingSetting & { readonly tenantId: string };
  /** This provider's ceiling on *each* pool's concurrent requests, from
   * Routing Strategy. Distinct from `max_inflight` (one account) and from
   * `network_pool_limits` (one pool, every provider). Absent = unlimited, the
   * default, and then no per-provider counter is ever touched. */
  readonly network_pool_provider_limit?: number;
  /** `null`/`undefined` = globally routable; a tenant id = routable only for that tenant's requests (BYOK). */
  readonly tenant_id?: string | null;
  /**
   * The tenant that owns this candidate's account (`provider_accounts.tenant_id`),
   * or null for a shared pool-wide account. Distinct from `tenant_id` (the
   * requesting tenant). Used to scope the admission bucket: a shared account
   * is one bucket across tenants; a tenant-owned account is scoped to its
   * owner so two tenants cannot drain each other's ceiling.
   */
  readonly owner_tenant_id?: string | null;
  /** `false` only for a genuinely credential-less provider (e.g. OpenCode
   * Free) dispatched with zero `provider_accounts` rows — the handler skips
   * `resolveCredentialForAccount` and dispatches with a `"none"` credential.
   * Absent/`true` preserves the existing invariant: no account configured
   * means the route is unusable, not silently public. */
  readonly requires_account?: boolean;
  /**
   * True when the upstream refuses this model on a free plan.
   *
   * Three-valued by absence as well as by value: only `true` excludes a free
   * account. `false` and absent both mean the model is not known to be gated,
   * and routing must not turn "not known" into "free accounts may serve it" —
   * that would send pro-only traffic to an account that is certain to be
   * refused.
   */
  readonly pro_only?: boolean;
  /**
   * True when the provider publishes this model as free (its own directory
   * statement, e.g. Qoder's `is_free`). A free model may be routed to any
   * account — the credit-preference ordering skips it entirely.
   */
  readonly free_tier?: boolean;
  /**
   * The plan the provider last reported for `provider_account_id`.
   *
   * Absent means the plan was never read, which is a different state from
   * "free": guessing free here would defeat the gate it exists to serve.
   */
  readonly account_plan?: string | null;
  /** Usage-floor ceiling from Routing Strategy; read live at plan time. */
  readonly usage_floor?: number;
  readonly usage_floor_unit?: "credit" | "percent";
  /** Live quota windows (cache) the floor check evaluates. */
  readonly quota_windows?: readonly unknown[];
}

/**
 * Provider-routing strategies. The runtime tuple is the source: the console's
 * Elysia body schema builds its `t.Literal` union from these values and its
 * operations layer validates direct callers against the same list, so a new
 * strategy cannot land in one and be silently missing from the other.
 */
export interface ProviderRoutingSetting {
  readonly strategy: ProviderRoutingStrategy;
  /** Requests served by one account before round robin advances. */
  readonly rotateCount: number;
  /** Per-account inflight ceiling from the routing panel; `null` = unlimited
   * concurrency per account. */
  readonly maxInflight: number | null;
  /** Per-pool inflight ceiling for this provider; `null` = unlimited, and
   * `null` is the default. Bounds one provider's share of one proxy pool,
   * independently of `maxInflight` (one account) and of the pool's own
   * `network_pools.max_inflight` (every provider). */
  readonly maxInflightPerProxy: number | null;
  /** Minimum remaining allowance an account must hold to stay routable.
   * `null` means no floor. `credit` compares the summed remaining credit;
   * `percent` compares the aggregate credit percent and lowest independent
   * percentage-only window. */
  readonly usageFloor: number | null;
  readonly usageFloorUnit: "credit" | "percent";
  readonly enabled: boolean;
  /** Built-in API-key User-Agent; OAuth and custom providers retain their identities. */
  readonly userAgent?: string;
  /** When true, this (tenant, provider) dispatches direct — candidates
   * never carry `network_pool_ids` regardless of pool availability. */
  readonly skipProxy: boolean;
}

/**
 * Providers whose routing defaults to `skipProxy: true` when no explicit
 * settings row exists yet for a given (tenant, provider) pair. Not a hard
 * lock — an explicit `skipProxy: false` row overrides this same as any
 * other provider. Picks the starting value for providers that commonly
 * don't work through a plain HTTP/S proxy; route them via a SOCKS5 or
 * proxy pool instead if proxying is required. Consumed by both the
 * console API default (`console/domains/provider-detail.ts`) and the real
 * `transport/routing/route-catalog.ts` so the two never drift.
 *
 * Single owner is the manifest `defaultSkipProxy` flags in
 * `providers/metadata.ts`; consumers import it directly from there.
 */

/**
 * Snapshot-level map carrying per-tenant per-provider routing preferences.
 * Outer key is tenantId string, inner key is providerId. Global settings
 * (tenant_id IS NULL) are stored under the sentinel "__global__".
 */
export type ProviderRoutingMap = Readonly<
  Record<string, Readonly<Record<string, ProviderRoutingSetting>>>
>;

/**
 * Pool-group selection strategy for one tenant — the network-pool counterpart
 * to `ProviderRoutingSetting`. `least_loaded` (default) keeps the weighted
 * least-loaded scan with its rotating tie-break; `round_robin` serves
 * `rotateCount` requests per pool before advancing and skips over capacity or
 * cooldown pools the way account failover does.
 */
export interface PoolRoutingSetting {
  readonly strategy: PoolRoutingStrategy;
  /** Requests served by one pool before round robin advances. */
  readonly rotateCount: number;
}

/**
 * Exact account a request must be routed to, because a provider session is
 * already live on it.
 *
 * A tool result for a Cursor Run is only meaningful on the account whose Run
 * asked for the call. Routing it to a sibling account — even a healthy one —
 * writes the result into an unrelated upstream turn, so affinity is a hard
 * constraint on the candidate set rather than a preference: `plan` pins to this
 * account or refuses.
 */
export interface RouteContinuationAffinity {
  readonly providerId: string;
  readonly providerAccountId: string;
  /**
   * True when the request's tool-result ids are all already answered by the
   * conversation history (a replay), so no call is still owed to the pinned
   * account. In that case, if the pinned account is no longer routable for
   * the requested model, the request may safely rebase to a fresh Run on an
   * eligible account instead of being refused — the recorded exchange travels
   * as history. When false, the pin is a hard constraint: a live pending call
   * must reach the exact account that owns it.
   */
  readonly rebaseable: boolean;
}

export interface RoutePlan {
  readonly revision: RoutingRevision;
  readonly candidates: readonly RouteCandidate[];
  readonly requested_model: string;
  readonly resolved_model: string;
  readonly provider_id: string;
  /**
   * The system decision behind each candidate, keyed by the candidate's
   * admission bucket. Written once at plan time; every later layer (dispatch,
   * telemetry) reads this instead of re-deriving its own ordering.
   */
  readonly decisions: ReadonlyMap<string, RoutingDecision>;
}

/** How eligible a candidate is and why — written once, read by every layer. */
export const ROUTING_RANK = {
  FRESH: 0,
  SLOW: 1,
  COOLING: 2,
  SATURATED: 3,
} as const;
export type RoutingRank = (typeof ROUTING_RANK)[keyof typeof ROUTING_RANK];

export interface RoutingDecision {
  readonly eligible: boolean;
  readonly rank: RoutingRank;
  readonly reason: string;
  readonly health_status?: string;
  readonly cooldown_until?: number;
  readonly floor_blocked?: boolean;
  readonly plan_gate_blocked?: boolean;
  readonly capability_blocked?: boolean;
  readonly saturated?: boolean;
}

import type { ComboStrategy, PoolRoutingStrategy, ProviderRoutingStrategy } from "../../persistence/schema";
import { providerRoutingStrategy } from "../../persistence/schema";

export { type ProviderRoutingStrategy };

/** Provider-routing strategies, derived from the persisted enum so the console
 * body schema and the routing engine validate against one list. */
export const ROUTING_STRATEGIES = providerRoutingStrategy.enumValues;

export interface ComboDefinition {
  readonly members: readonly string[];
  readonly strategy: ComboStrategy;
}

export interface RouteSnapshot {
  readonly revision: RoutingRevision;
  readonly candidates: readonly RouteCandidate[];
  readonly aliases: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** CLI source→target mappings, enabled only for API keys with the feature scope. */
  readonly cli_aliases?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly combos: Readonly<Record<string, Readonly<Record<string, ComboDefinition>>>>;
  readonly created_at: number;
  /** Optional per-provider routing preferences keyed by tenant. */
  readonly providerRouting?: ProviderRoutingMap;
  /** Optional per-tenant pool selection strategy (absent = `least_loaded`). */
  readonly poolRouting?: Readonly<Record<string, PoolRoutingSetting>>;
  /**
   * Tenants whose invoke switch is off, so `/v1/*` must be refused outright.
   *
   * Read from the cached snapshot rather than per request: it is a console
   * preference write, and the snapshot is already invalidated when one lands, so
   * the switch takes effect on the next request without adding a query to the
   * proxy path.
   */
  readonly invokeDisabledTenants?: ReadonlySet<string>;
}

export type EligibilityReason =
  | "healthy"
  | "slow"
  | "cooldown"
  | "cooldown_hard"
  | "model_cooldown"
  | "quota_exhausted"
  | "locked"
  | "disabled"

export interface EligibilityDecision {
  readonly eligible: boolean;
  readonly reason: EligibilityReason;
  readonly candidate: RouteCandidate;
  /**
   * Epoch milliseconds at which this candidate's cooling window ends, when the
   * exclusion that produced this decision carries one. Absent for a healthy
   * candidate and for every reason with no deadline (`disabled`, `locked`,
   * `quota_exhausted` from spent windows or the usage floor). `plan()` takes the
   * minimum across the cooling set to report the earliest reset a client could
   * retry against.
   */
  readonly cooldown_until?: number;
}

export interface Reservation {
  readonly candidate: RouteCandidate;
  readonly lease_id: string;
  readonly expires_at: number;
  readonly acquired_at: number;
}

export interface RouteSnapshotService {
  getSnapshot(): Promise<RouteSnapshot>;
  invalidate(): Promise<RoutingRevision>;
}

/** One admission decision: whether the candidate got a slot, and why not. */
export interface AdmissionDecision {
  readonly admitted: boolean;
  readonly reason?: string;
}

export interface AdmissionController {
  admit(candidate: RouteCandidate): Promise<AdmissionDecision>;
  release(reservation: Reservation): Promise<void>;
  /**
   * Current inflight counts for exactly the buckets the given candidates draw
   * from, keyed by the unprefixed admission bucket (`provider:model[:account]`).
   *
   * Required, not optional: the previous fleet-wide
   * `snapshotAccountInflight()` was the only reason `plan()` could issue a
   * Redis `KEYS` on the request path. Scoped reads make the ordering cost
   * proportional to the candidates being ordered, and an empty input must be
   * answerable with zero backend commands.
   */
  readAccountInflight(
    candidates: readonly RouteCandidate[],
  ): Promise<ReadonlyMap<string, number>> | ReadonlyMap<string, number>;
}

/**
 * Translates the evaluator's internal reason codes into operator English.
 *
 * These names are the vocabulary the routing layers use with each other —
 * `model_cooldown`, `cooldown_hard`, `locked` — not something to print into the
 * public message, where the client would read an enum instead of an
 * explanation. The codes stay in the envelope's `reasons` field for anyone who
 * wants them; the sentence carries what they mean.
 *
 * Unmapped names are still readable: they fall through as themselves rather
 * than being dropped, so a new reason shows up in the message on the day it is
 * added instead of vanishing until someone remembers this map.
 */
const ELIGIBILITY_REASON_LABELS: Readonly<Record<string, string>> = {
  model_cooldown: "every account is cooling down for this model",
  cooldown_hard: "every account is in a hard cooldown",
  cooldown: "accounts are cooling down",
  disabled: "all accounts are disabled",
  locked: "all accounts are locked by another request",
  credit_floor_reached: "credit or quota is exhausted",
  quota_exhausted: "every account has an exhausted quota window or is below its configured usage floor",
  capability_unsupported: "the accounts serving this model do not support the request's capabilities (e.g. images, tools, or reasoning)",
};

function explainEligibilityReasons(reasons: readonly string[]): string {
  if (reasons.length === 0) return "no eligible candidate";
  const parts = reasons.map((reason) => ELIGIBILITY_REASON_LABELS[reason] ?? reason);
  const distinct = [...new Set(parts)];
  return distinct.length === 1 ? distinct[0]! : distinct.join("; ");
}

export function ambiguousModelError(bare: string, owners: string[]): GatewayError {
  return new GatewayError(
    "ambiguous_model",
    400,
    `'${bare}' matches more than one provider (${owners.join(", ")}). Qualify it as '${owners[0]}/${bare}', or add an alias to pick one. Too popular for its own good — qualify it 🧩`,
    {
      model: bare,
      owners,
    },
  );
}

/**
 * The requested name resolves to nothing, or no candidate serves its resolved
 * target. `resolved` carries the post-alias/combo target(s) so an alias whose
 * model disappeared from the catalog is diagnosable from the error alone,
 * instead of reading like a typo in the client's own request.
 */
export function modelNotFoundError(requested: string, resolved: readonly string[] = []): GatewayError {
  const targets = resolved.filter((name) => name !== requested);
  const hint = targets.map((name) => `'${name}'`).join(", ");
  return new GatewayError(
    "model_not_found",
    404,
    `'${requested}' is not routed${
      targets.length > 0 ? ` — it resolved to ${hint}, which no account serves` : ""
    } (request {requestId}). Enable the model on an account, or point the alias at one that exists. Try another model — this one's off the menu 📚`,
    {
      model: requested,
      ...(targets.length > 0 ? { resolved_models: targets } : {}),
    },
  );
}

export function capabilityUnsupportedError(capability: string): GatewayError {
  return new GatewayError(
    "capability_unsupported",
    400,
    `No account serving this model supports ${capability} (request {requestId}). Drop the ${capability} part of the request, or route to a model that accepts it. Know your tools — this one just isn't in the box 🧰`,
    { capability },
  );
}

/**
 * Every candidate in the plan refused admission: each account is already
 * serving its configured max-inflight.
 *
 * Deliberately NOT `capacity_exhausted`. That code also belongs to the API-key
 * admission layer (`security/admission`, reason `concurrency-limit`), which
 * enforces a key's own `max_concurrent`. Sharing one code made the two
 * indistinguishable on the wire: an operator who raised the provider's
 * max-inflight saw no change because the rejection was the *key's* ceiling, and
 * vice versa. Distinct codes let each be read off the envelope alone.
 *
 * The counts are carried in `details` because the interesting question is never
 * "was it rejected" but "was every account really full, or did the plan only
 * carry one candidate" — the latter is a routing/eligibility problem that
 * raising the ceiling will not fix.
 */
export function capacityExhaustedError(context?: {
  readonly providerId?: string;
  readonly model?: string;
  readonly candidateCount?: number;
  readonly maxInflight?: number;
}): GatewayError {
  const onlyOne = context?.candidateCount === 1;
  return new GatewayError(
    "provider_capacity_exhausted",
    429,
    onlyOne
      ? "The only account routing this model is at its concurrency limit (request {requestId}). Retry shortly; if it persists, raise the provider's max-inflight or add another account. Even the machine needs a rest — chill 🦋"
      : "Every account is at its concurrency limit (request {requestId}). Retry shortly; if it persists, raise the provider's max-inflight or add an account. Even the machine needs a rest — chill 🦋",
    {
      ...(context?.providerId !== undefined ? { providerId: context.providerId } : {}),
      ...(context?.model !== undefined ? { model: context.model } : {}),
      ...(context?.candidateCount !== undefined
        ? { candidate_count: context.candidateCount }
        : {}),
      ...(context?.maxInflight !== undefined ? { maxInflight: context.maxInflight } : {}),
    },
  );
}

/**
 * The model exists and is routed, but every account serving it is currently
 * unusable (disabled / locked). This is transient and
 * retry-able, so it must NOT surface as `model_not_found` — a 404 tells the
 * client to fix its request when the real fix is to wait or add capacity.
 *
 * The public message names only what the client asked and why it cannot be
 * served. Combo/alias resolution detail (which member lacked candidates)
 * stays server-side — the operator reads it in the server logs, never the
 * client envelope.
 */
export function accountsUnavailableError(
  requested: string,
  reasons: readonly string[],
): GatewayError {
  const distinct = [...new Set(reasons)].sort();
  const capabilityBlocked = distinct.includes("capability_unsupported");
  // When the blocker is a capability (the model exists and accounts exist, but
  // none can carry the request's images/tools/reasoning), telling the client to
  // "add an account" or wait out a coffee break is misleading — more accounts
  // cannot conjure a capability the model itself lacks. Name the real fix.
  const hint = capabilityBlocked
    ? "Request a model that supports this capability (or a vision-capable model for images), or drop the unsupported part of the request. The model is the limit, not the pool 🧰"
    : "Add an account, or wait for an operator to re-enable one. Every account is on a coffee break — try later ☕️";
  return new GatewayError(
    "accounts_unavailable",
    503,
    `No account in the pool can serve '${requested}' right now (request {requestId}) (${explainEligibilityReasons(distinct)}). ${hint}`,
    { model: requested, reasons: distinct, candidate_count: reasons.length, gateway_hint: "no_healthy_account" },
  );
}

/**
 * The model is routed, but every candidate that could serve it is currently
 * cooling down (rate limited, quota exhausted, or transiently failed).
 *
 * Distinct from {@link accountsUnavailableError}: that 503 means *no usable
 * account exists* (all disabled or model-cooling), where waiting does not help
 * until an operator acts. This 429 means accounts exist but every one is inside
 * a cooldown window — the correct answer is "rate limited, retry after the
 * reset", and dialing a cooling account can only reproduce the same refusal.
 * Returning 503 here told a client to keep retrying capacity that is merely
 * resting, and 404 would blame the request.
 */
export function accountsRateLimitedError(
  requested: string,
  routed: string = requested,
  /** Earliest epoch-ms instant any cooling candidate recovers, when known. */
  earliestResetMs?: number,
): GatewayError {
  const routeNote = routed === requested ? "" : ` (routed to '${routed}')`;
  // The reset rides as `retryAfterMs`, the same hint every other retryable
  // failure uses, so `error-lifecycle.ts` turns it into a real `retry-after`
  // header instead of the one-second floor it falls back to. Reporting the
  // actual earliest recovery is the difference between a client that waits out
  // the window and one that re-dials a resting account every second.
  const retryAfterMs =
    earliestResetMs !== undefined && earliestResetMs > Date.now()
      ? earliestResetMs - Date.now()
      : undefined;
  return new GatewayError(
    "accounts_rate_limited",
    429,
    `Every account serving '${requested}'${routeNote} is cooling down after hitting upstream limits (request {requestId}). The request is fine — retry once the cooldown resets. They're resting up 🌸`,
    {
      model: requested,
      routed_model: routed,
      reason: "all_accounts_cooling",
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    },
  );
}



import { publishRoutingInvalidation, subscribeRoutingInvalidation } from "../../persistence/shared-cache";

export type SnapshotBuilder = () => Promise<
  Omit<RouteSnapshot, "revision" | "created_at"> & { created_at?: number }
>;

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === "object" && !Object.isFrozen(obj)) {
    for (const v of Object.values(obj as Record<string, unknown>)) {
      if (v && typeof v === "object") deepFreeze(v as unknown as T);
    }
    Object.freeze(obj);
  }
  return obj;
}

export class InMemoryRouteSnapshotService implements RouteSnapshotService {
  private revision: RoutingRevision = 0;
  private snapshot: RouteSnapshot | undefined;
  /**
   * The in-flight build, tagged with the revision it is building.
   *
   * The tag is what keeps a mutation from being lost. A build reads the catalog
   * over ten Postgres round-trips, so a dashboard write can land while one is
   * in flight. Without the tag two things go wrong: a reader that arrives
   * *after* the mutation is handed the still-running pre-mutation build, and
   * that build then overwrites the cache the mutation has just cleared — so the
   * data plane serves stale routing until some later write invalidates it
   * again. A build may only be reused by readers at its own revision, and may
   * only populate the cache if no mutation happened while it ran.
   */
  private building: { revision: RoutingRevision; promise: Promise<RouteSnapshot> } | undefined;

  constructor(private readonly builder: SnapshotBuilder) {
    // Peers' mutations arrive once per process, not per instance: the handler
    // drops this instance's copy, which is the only one there is.
    this.unsubscribe = subscribeRoutingInvalidation(() => {
      this.revision += 1;
      this.snapshot = undefined;
    });
  }

  /** Ends the peer-invalidation subscription. */
  readonly unsubscribe: () => void;

  async getSnapshot(): Promise<RouteSnapshot> {
    if (this.snapshot) return this.snapshot;
    if (this.building && this.building.revision === this.revision) return this.building.promise;
    const revision = this.revision;
    const promise = this.build(revision);
    this.building = { revision, promise };
    try {
      return await promise;
    } finally {
      // Only the build that is still current may clear the slot; a build
      // started after a mutation must not be dropped by an older one finishing.
      if (this.building?.promise === promise) this.building = undefined;
    }
  }


  async invalidate(): Promise<RoutingRevision> {
    this.revision += 1;
    this.snapshot = undefined;
    // Lazy: the next getSnapshot() rebuilds. Dashboard mutations only need
    // the new revision token — they must not pay seven Postgres round-trips
    // inside the mutating request while holding no pool pressure budget.
    //
    // Broadcast, because `reusePort` runs several gateway processes and each
    // holds its own snapshot: a console write handled by one of them left the
    // others serving pre-write routing until something else invalidated them.
    // Peers drop their copy on receipt and rebuild lazily, same as here — the
    // notice carries no data, so there is nothing to deserialize.
    publishRoutingInvalidation();
    return this.revision;
  }

  private async build(revision: RoutingRevision): Promise<RouteSnapshot> {
    const built = await this.builder();
    const providerRouting: ProviderRoutingMap | undefined = built.providerRouting
      ? Object.fromEntries(
          Object.entries(built.providerRouting).map(([tenantId, settings]) => [
            tenantId,
            Object.fromEntries(
              Object.entries(settings).map(([providerId, setting]) => [
                providerId,
                { ...setting, rotateCount: setting.rotateCount ?? 1 },
              ]),
            ),
          ]),
        )
      : undefined;
    // One literal for both routing modes: two verbatim copies differing only by
    // the `providerRouting` key would mean a snapshot field added to one branch
    // silently vanishes on the other.
    const snapshot = deepFreeze({
      revision,
      candidates: Object.freeze([...built.candidates]) as readonly RouteCandidate[],
      aliases: Object.freeze({ ...built.aliases }),
      ...(built.cli_aliases ? { cli_aliases: Object.freeze({ ...built.cli_aliases }) } : {}),
      combos: Object.freeze({ ...built.combos }),
      ...(providerRouting ? { providerRouting } : {}),
      // Unfrozen copy: deepFreeze must reach the inner per-tenant settings —
      // a pre-frozen record trips its is-frozen guard and skips recursion.
      ...(built.poolRouting ? { poolRouting: { ...built.poolRouting } } : {}),
      created_at: built.created_at ?? Date.now(),
    });
    // A mutation during the build means this snapshot describes a catalog that
    // has already been superseded. Returning it is fine — the caller asked
    // before the mutation — but caching it would strand the data plane on stale
    // routing until the next write.
    if (revision === this.revision) this.snapshot = snapshot;
    return snapshot;
  }
}
