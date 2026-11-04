# Usage floor

Usage floor is a per-provider routing threshold. When one account's remaining
allowance reaches or falls below its configured floor, the router **orders**
that account behind accounts with more allowance — it does **not** exclude it
from routing. The request may still be sent to a below-floor account; the
upstream is the one that answers, and its refusal is then classified (e.g.
into a cooldown). This changed from an exclusion to an ordering-only signal so
that free-tier and exhausted accounts remain reachable when the operator wants
them tried.

## Setting and scope

The control appears in the provider detail page above that provider's account
list. It is stored in `provider_routing_settings` as `usage_floor` and
`usage_floor_unit`; the row is tenant- and provider-scoped (a null tenant id is
the shared/global setting where applicable). A null floor disables the
threshold. The unit is `percent` or `credit`.

The UI also shows combined pooled credits across active accounts when the quota
data supports that calculation. This is an overview only: the floor is still
evaluated separately against each account's quota windows.

## Ordering (not eligibility)

`creditPriority` uses the floor and quota windows to order candidates inside the
same rank group:

- `credit` compares the candidate's remaining pooled credit against the
  configured credit amount.
- `percent` compares the aggregate pooled-credit percentage and the lowest
  independent percentage-only window against the configured percentage.
- A known exhausted pooled balance or independent quota window orders the
  account behind unknown/positive accounts — it does not exclude it.
- No usable quota reading is unknown, not zero. It is treated neutrally.
- A model-scoped grant only gates its listed model IDs for ordering.
  Alternative grants for that model are usable when any live grant exceeds the
  floor; a spent sibling model's grant does not affect this candidate. Future
  or expired grants do not fund requests. Account-wide windows still constrain
  every candidate.

A candidate is only excluded by health state (`disabled`, hard cooldown, model
cooldown). Quota never excludes. The router still orders eligible candidates,
and if no candidate remains the normal routing failure path applies. This is a
routing policy, not account health state: it does not itself write a cooldown.

## Quota freshness and recovery

A completed request debits the credits it reported from the account's cached
pooled balance. The sweep is the only thing that fetches a fresh reading, and
it runs at most every eight minutes; without the debit the floor keeps
selecting an account whose balance already crossed the threshold. The debit
preserves `fetchedAt`, so the sweep still refreshes on its own schedule, and
it never invents a balance for an account whose last fetch failed.

Quota reads use a bounded in-process cache and, when configured, Redis. The
cache uses a 15-minute TTL and distinguishes the most recent attempt from the
most recent successful reading. A failed refresh does not immediately discard
a successful reading: it is retained, with the refresh error recorded, for up
to 30 minutes from that success. After that window, a failed result is not
treated as a successful balance.

The `quota-refresh-sweep` worker runs every 60 seconds, selects entries at
least eight minutes old — half the 15-minute cache TTL, so an entry is
refreshed roughly twice per window rather than three times — orders them
oldest first, and bounds a pass to 40 accounts and 45 seconds — the budget is
set in `src/boot/dependencies.ts`, the account cap is the worker's own default.
It is registered in Lite and Full modes; Redis is not
a prerequisite. Opening a quota view normally reads the warmed cache, while a
cold account read can still wait for its first upstream fetch. Queued and
in-flight background refreshes are included in the overview's pending state.

Verify current policy and limits in:

- `src/transport/routing/router.ts` — threshold and exhausted-window decision.
- `src/providers/quota/cache.ts` — cache envelope, TTL, retention after failure.
- `src/console/quota/quota-view.ts` and `account-quota-tenant.ts` — view state
  and cold/background refresh paths.
- `src/workers/quota-refresh-sweep.ts` and `src/boot/dependencies.ts` — sweep
  bounds and registration.
- `dashboard/src/features/provider-detail/sections/UsageFloorControl.tsx` —
  operator control and combined-balance display.

## Where to change what

| Change | Start here |
| --- | --- |
| Threshold evaluation or failover behavior | `EligibilityEvaluator` in `src/transport/routing/router.ts` |
| Persisted setting or route snapshot input | `providerRoutingSettings` in `src/persistence/schema.ts`, then the routing settings store/loader |
| Quota parsing or accounting windows | `src/providers/quota/` and the provider collector |
| Cache freshness or failure retention | `src/providers/quota/cache.ts` and its focused tests |
| Refresh scheduling and sweep budget | `src/workers/quota-refresh-sweep.ts`, registered in `src/boot/dependencies.ts` |
| Console and dashboard presentation | `src/console/quota/`, then the provider-detail usage-floor section |

## See also

- [Architecture](../reference/architecture.md) — candidate eligibility in the
  request path.
- [Providers](../reference/providers.md) — provider quota contracts and
  accounting.
- [Health-routing skill](../../.skills/cartethyia-health-routing/SKILL.md) —
  routing, failover, cooldowns, and leases.
