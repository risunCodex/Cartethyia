---
name: cartethyia-health-routing
description: "Change or debug account health, cooldown classes, pool selection, retries, leases, and rotation. Use when touching account-health-service, src/transport/routing/, health UI, or a 429/503 that names accounts."
---

# Health, routing, and retries

Use when changing account health, cooldowns, pool selection, retries, leases, or
health UI.

## Authorities

- `src/providers/operations/account-health-service.ts` owns account health
  transitions.
- `src/transport/routing/` owns selection, leases, retry, and rotation policy.
- `dashboard/src/` displays server state; it must not invent a second health
  machine.
- Model-level cooldown is distinct from account-level cooldown.

Before changing a status or timeout, trace every reader and branch that uses it.

## Rules

- A cooldown is not automatically an unhealthy account.
- Account-wide cooldowns carry a class, defined in `HARD_COOLDOWN_CATEGORIES`
  (`src/transport/routing/route-catalog.ts`) and projected onto the candidate
  as `cooldown_kind` — the health/cooling/lane stamps are typed as
  **`RoutedCandidate`** (`src/transport/routing/route-model.ts`), the shared
  shape `EligibilityEvaluator.evaluate` takes; stamping sites must agree on it
  rather than declaring local intersections:
  - **hard** — `quota_exhausted`, `policy_blocked`, `auth_invalidated`. When
    represented as a cooldown, excludes the account until its deadline.
    Non-recoverable `auth_invalidated` failures can instead disable the account
    without a timed cooldown.
  - **soft** — stays eligible but is ordered after every healthy sibling.
- A **slow lane** (`lane: "slow"`, Claude first-party OAuth) is orthogonal to
  cooldown, never a member of `HARD_COOLDOWN_CATEGORIES`. The account still
  serves on spare capacity via `anthropic-usage-limit: slow`, so it stays
  **eligible** with reason `slow` and merely orders behind fresh siblings
  (fresh → slow → cooling → saturated). Excluding it would park a serving
  credential, and an all-slow pool must still dial: `healthyCount` counts
  `slow` as servable, so it must never answer 429 while capacity sits idle.
  - The ordering branch sits **after** the usage-floor gate. "Orthogonal"
    means it adds no exclusion, not that it overrides one — an account below
    its floor has no spare capacity for the lane to spend.
  - A slow-lane **capacity wait** (429 `slot_busy`, or 529 /
    `overloaded_error`, while the slow header was sent) retries the *same*
    account after the server-stated interval, jittered and bounded by the
    server's max-wait and the request deadline, with leases released during the
    wait. It is not a failure: it records no health and writes no cooldown.
    Terminal lane ends (`weekly_limit`, `budget_exhausted`, `off`,
    `ineligible`, max-wait exceeded) are the only slow-lane events that mutate
    health — as `quota_exhausted` at the stated reset.
- `model_cooldown` is a hard exclusion per (account, model).
- **Quota windows are filtered to the requested model's family** before the
  usage-floor and exhausted-window checks (`filterCandidateQuotaWindows` in
  `src/transport/routing/router.ts`): providers that report per-family windows
  (Antigravity splits Gemini vs Claude/GPT; Grok uses per-`product:` buckets)
  no longer block every model when one family is exhausted. A Claude
  exhaustion still routes Gemini. Diagnosis note: "quota exhausted" is
  family-scoped for those providers, not account-wide.
- If every candidate is excluded, `plan()` answers **429
  `accounts_rate_limited`** when an exclusion reason is `cooldown_hard` or
  `model_cooldown`, or `quota_exhausted` **carrying a stated window reset**
  (`cooldown_until` derived from the quota window — a time-bounded floor
  exclusion); a floor with no stated reset stays **503
  `accounts_unavailable`**, as do the other all-excluded cases. Separately,
  account-wide soft cooldowns remain
  eligible but are not dialed when all eligible accounts are cooling
  (`healthyCount === 0`); that case also answers 429. Both 429 paths let a
  client retry after the reset instead of reading a resting deployment as
  down.
- An active account may still have model-level cooling entries.
- Quota exhaustion, disabled state, cooldown, and model cooling must stay
  distinguishable in API and UI; do not sum them into a misleading total.
- Retry only when the failure policy says the same account or request is safe to
  retry. An **account-scoped** upstream failure is retryable regardless of HTTP
  status — that evidence is exactly what failover exists for. **Provider-scoped**
  failures still follow the status/code allowlist.
- One request dials at most `CARTETHYIA_ROUTE_MAX_ATTEMPTS` candidates (default
  8, range 1–64, resolved by `resolveRouteMaxAttempts()` in
  `src/config/timeouts.ts`).
- Provider-specific exceptions must be explicit, narrow, and documented at the
  owner.
- Buddy credit exhaustion (`14018` or `credits exhausted`) is `quota_exhausted`: a hard cooldown for 12 hours unless the provider states a duration. The existing account-health sweep restores it when `cooldownUntil` passes.
- A **CodeBuddy/WorkBuddy frequency window** — the message contains "usage exceeds frequency limit" *and* "switch to the other models" — is `rate_limit_transient`, so it cools **the model** (`modelCooldowns[modelId]`), not the account. The provider names the remedy itself — use another model — which is only a remedy while the account still serves its sibling models; parking the account took them all down with it. Matched on the message's wording, never on the `6004` code (that code is reused elsewhere, so a code match swept unrelated failures into a quota cooldown).
- The same wording *without* "switch to the other models" is an account-wide `quota_exhausted` window instead: only the extra phrase is evidence that other models still work. A 429 with no quota phrasing at all is an ordinary `rate_limit_transient`.
- A retry must preserve the original request contract and release
  leases/resources.
- `plan()` orders accounts already at their admission inflight ceiling behind
  siblings with room, same as it deprioritizes cooling accounts. Saturated
  candidates are deprioritized, not excluded, so a request still gets a 429
  when every eligible account is genuinely busy instead of answering `503
  accounts_unavailable`.
- A follow-on attempt is skipped when the wall-clock left against the request
  deadline is below the per-attempt floor; the first attempt is never guarded,
  and the first attempt's error (with its last upstream exchange) is surfaced
  rather than a second attempt's deadline timeout.
- A proxy's `CONNECT` refusal with `402` or `407` is attributed to the pool
  (typed `ProxyConnectRefusalError`), not the account dialed through it. The
  pool is disabled; the account's health is untouched. The symmetric Buddy
  rules above still apply to upstream `402`.

## Debug

1. Capture account id, provider, model, status, error category, and timestamps.
2. Follow the transition owner and the routing branch that consumed it.
3. Check whether the scope is account, model, pool, or request.
4. Reproduce with the real health/selection path; do not mutate a dashboard
   count.

## UI

Present mutually exclusive account statuses separately. A model-level warning may
coexist with Healthy, but must not relabel the account as Unhealthy. Show the
source status and avoid double-counting one account in multiple aggregate labels.

## Verify

The gate list is the [engineering verification reference](../cartethyia-engineering/references/verification.md);
run the applicable checks, plus `bun run test:backend`.

The boundary specific to this skill is health: exercise a real provider/account
or a production-path temporary probe, and report when upstream credentials or a
live gateway were unavailable.
