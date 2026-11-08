# Proposal — Proactive quota-aware account routing (drain, reserve, sticky, classified rotation)

Status: implemented (first slice) — see §7 for what shipped vs what did not
Scope: routing engine (`src/transport/routing/`), account health
(`src/providers/operations/`, `src/providers/quota/`), error classification
(`src/providers/operations/account-error-classification.ts`), config
(`src/config/cooldowns.ts`), persistence schema, console UI mirror.
Source of inspiration: `oh-my-pi` (`packages/ai/src/auth/{select,rank,blocks,rotation,usage-report,policy,affinity,usage-cache}.ts`,
`packages/ai/src/error/rate-limit.ts`, `packages/catalog/src/pricing.ts`).
English only in repo artifacts.

---

## 1. Why

Cartethyia's router already filters on health, orders by credit, applies a
usage floor, and plans reservations. What it does **not** yet do is
**balance the burn across accounts before a failure happens**. Today:

- an account is only removed from rotation after it *fails* (cooldown
  written post-hoc);
- every healthy account is roughly equivalent to the router, so request
  patterns can drain one account to zero while siblings sit idle;
- a single 429 that is actually a transient per-minute throttle parks the
  account for the generic 15-minute fallback, wasting a healthy key;
- the same session can hop accounts between requests, losing prompt-cache
  warmth;
- there is no notion of a *reserved* account — quota kept in reserve for
  emergencies — and no way to reclaim it when it heals.

`oh-my-pi` solves all five. This proposal ports the useful parts
end-to-end, adapted to Cartethyia's existing health/quota model.

---

## 2. Design

### 2.1 Account ranking with drain urgency (`router.ts` + `candidate-index.ts`)

Add a **drain score** to candidate ordering, in the same spirit as omp's
`windowRequiredDrain` (`packages/ai/src/auth/usage-report.ts`):

```
drain = headroomFraction / remainingHoursUntilReset
```

- `headroom = 1 - usedFraction` of the most-urgent relevant window.
- `remainingHours` = time until the window resets (or the window duration
  when no reset clock exists), floored at 1 minute so a stale report never
  produces unbounded urgency.
- Higher drain = quota that is about to expire unused → rank first. This
  chases "use it or lose it" so staggered resets land at ~100% utilization.

Ordering becomes, per eligible candidate (within the same rank group):

1. **sticky warm pin**: the account that last served this session wins if
   the warm window (default 5 min) is still active; an explicit operator pin
   wins unconditionally
2. **free-tier bypass**: both free-tier → return 0 (original order kept)
3. **reserve demotion**: `in_reserve` (remaining fraction ≤ `reservePct`,
   default 20%) ranks *behind* non-reserve siblings
4. **account priority** (operator-configured, higher first)
5. **hot-window guard**: ≥85% used ranks *behind* cooler siblings, no matter
   its drain score — overflow lands on a cool account, not the one about to
   block mid-session
6. **credit priority** (existing)
7. **drain score**, descending (headroom / remaining hours until reset)

Note: the rank (FRESH_KNOWN/FRESH_UNKNOWN/SLOW/COOLING/SATURATED) is the
primary sort key; these preferences only order within one rank group.

The router already has `quota_windows`, `remainingPercent`, `resetsAt`,
and `usage_floor` on `RoutedCandidate` — the drain score is computed from
the same data, no new fetch.

### 2.2 Account reserve + reclaim (policy layer + console)

Port omp's reserve semantics (`policy.ts`, `select.ts`):

- New config knob **`CARTETHYIA_ACCOUNT_RESERVE_PCT`** (default 20): an
  account whose remaining fraction falls below `reservePct` is flagged
  `in_reserve` and demoted *behind* non-reserve siblings in ordering.
- The reclaim policy (`reclaimAbovePct`) is documented here as a follow-up
  but was not shipped: no knob is exposed yet, and the "reserved forever"
  trap is mitigated by the hot-window guard (a 90%-used account is demoted
  by reserve *and* hot, but re-eligible once below the reserve threshold).

This gives operators a strategic reserve: quota held back for bursts, and
a self-healing path back (see §2.5).

### 2.3 Classified rotation: rotate vs backoff (`account-error-classification.ts`)

Today classification maps an error to a category + cooldown. A second axis
was added: **`rotateAccount`** (switch to a sibling account now) vs backoff
(stay on this account, wait). Port omp's decision tree
(`error/rate-limit.ts` `isUsageLimitOutcome`):

| Signal | Action |
|---|---|
| Usage-limit text (quota, credits, spend cap) | rotate to sibling |
| Per-minute TPM/RPM wording ("too many requests", "tpm exhausted") | **backoff only** (same account) |
| Model-capacity / overloaded / 503 / 529 | backoff |
| `policy_blocked_banned` (banned credential) | rotate (disable) |

The `rotateAccount` axis is computed once in `result()` and in the shared
signals: quota/spend caps and account bans rotate; a transient 429/503/529
throttle never does — even when the category resolved to
`quota_exhausted` (e.g. "tpm exhausted (type=quota_exceeded_error)").

New price/usage wording added to `quotaSignal`:

- "insufficient credits", "credits exhausted", "out of credits",
  "insufficient balance", "balance exhausted".
- "spending cap", "spending limit", "monthly spend limit".

The sibling-availability wait (omp `awaitSiblingUnblock`) is **not** ported
in this slice — the router already rotates within the same rank group, and
the classifier decision is the axis the writer consumes. See §7.

### 2.4 Block provenance: timed vs untimed (`cooldowns.ts` + schema)

Omp distinguishes **provider-stated timing** (a parsed `retry-after`,
`retry-after-ms`, `x-ratelimit-reset`, or a usage-report reset window) from
**heuristic guesses** (the default fallback durations). Port this:

- Add `providerTimed: boolean` to the cooldown record.
- A **timed** deadline is trusted and informs `retry-after` surfaced to
  the client.
- An **untimed** (heuristic) deadline must never outrank a fresh usage
  report. If a newer quota snapshot says the account is healthy, the
  heuristic cooldown is cleared (healing, §2.5).
- Merge rule: longest-wins, with provenance following whichever deadline
  wins, exactly like omp's `blocks.ts`.

### 2.5 Healing: live quota clears stale blocks (quota refresh)

Port omp's `canHeal` + `clearScope`:

- When a quota refresh **succeeds** for an account that is in cooldown,
  clear the cooldown immediately, scoped by the category that parked it
  (today: the sweep only recovers expired rows).
- Only *healable* categories heal: `quota_exhausted`,
  `rate_limit_transient`, `model_capacity`, `model_unreachable`, `unknown`,
  `check_failed`, or a null category. Explicit auth rejections
  (`auth_invalidated`) and policy blocks never heal from a usage report —
  the credential is still refused.
- The heal writes `status: active`, clears `lastError*`/`cooldownUntil`,
  resets `consecutiveFailures`, and stamps `lastSuccessAt` +
  `lastRecoveredAt`. A non-healable cooldown row is left untouched (the
  success stamp does not leak onto a parked row).

### 2.6 Session affinity + warm window (routing engine)

Port omp's sticky affinity (`affinity.ts`):

- Key sticky state by **session id** (the caller's conversation id /
  `x-session-id` when present), remembering the last account served.
- **Warm window** (`CARTETHYIA_ROUTING_STICKY_WARM_MS`, default 5 min):
  within the window, prefer the sticky account if it is still eligible (not
  blocked, not exhausted) — prompt-cache warmth is worth more than perfect
  load balance.
- Past the window, stickiness no longer wins; the normal ranking runs.
- Explicit operator pin (console `continuationAffinity`) is recorded as
  explicit and wins even past the warm window.
- Bound: in-memory LRU per provider (`CARTETHYIA_ROUTING_STICKY_MAX_SESSIONS`,
  default 256). Not persisted — an evicted or restarted session simply
  loses its warm pin and resumes normal ranking.

### 2.7 Usage cache with stable identity (`quota/cache.ts`)

Port omp's `usageCacheIdentity`: key quota cache rows by stable account
identity (provider + accountId/email/org), **not** by raw token hash.
Today an OAuth refresh changes the token and invalidates the cache;
identity-keying keeps quota data across refreshes and across siblings of
the same account.

### 2.8 Optional: time-based pricing awareness (routing)

Omp models `offPeakMultiplier`, `peakWindows`, `effectiveRates`
(`pricing.ts`). This is a **later phase** (marked optional): expose the
pricing schedule the provider already reports, and let routing prefer
off-peak accounts when the request is not latency-sensitive. Requires
pricing data to be persisted per provider; out of the first slice.

---

## 3. File-by-file change map

| File | Change | Shipped? |
|---|---|---|
| `src/transport/routing/router.ts` | drain score in ordering; reserve flags; hot-window guard; sticky-aware order | ✅ |
| `src/transport/routing/drain-reserve.ts` | new: `drainScore`, `remainingFraction`, `isInReserve` | ✅ |
| `src/transport/routing/round-robin.ts` | `StickySessionStore` (LRU per provider) | ✅ |
| `src/transport/routing/route-model.ts` | `account_priority`, `in_reserve`, `drain_score`, `sticky_account_id` fields | ✅ |
| `src/transport/request/preparer.ts` | pass `conversation_id` as session id to `plan()` | ✅ |
| `src/providers/operations/account-error-classification.ts` | `rotateAccount` axis; quota/spend/cap wording | ✅ |
| `src/providers/quota/refresh.ts` | `recordAccountCheck` heal-on-success (category-scoped) | ✅ |
| `src/config/spec.ts` + `src/config/routing.ts` | `CARTETHYIA_ACCOUNT_RESERVE_PCT`, `CARTETHYIA_ROUTING_STICKY_WARM_MS`, `CARTETHYIA_ROUTING_STICKY_MAX_SESSIONS` | ✅ |
| `documentation/reference/configuration.md` | regenerated from spec | ✅ |
| `src/providers/operations/account-health-service.ts` | timed/untimed provenance | ❌ not in slice |
| `src/providers/quota/cache.ts` | stable account-identity cache keys | ❌ not in slice |
| migrations | `provider_accounts` reserve/reclaim fields; cooldown `providerTimed` flag | ❌ not in slice |
| console mirror | quota page shows reserve/reclaim thresholds; account row shows drain score | ❌ not in slice |

---

## 4. Testing plan

- ✅ **Unit — drain math**: `test/transport/drain-reserve-routing.test.ts` —
  known windows → expected ordering; hot-window guard demotes 90%-used over
  40%-used even when drain is higher; fully-used → 0; no windows → neutral.
- ✅ **Unit — reserve**: below-reserve demoted; reserve 0 never reserves;
  free-tier bypass keeps original order.
- ✅ **Unit — classification table**: `test/providers/classification-rotate-account.test.ts` —
  table-driven assertion of every new pattern → rotate vs backoff verdict
  (quota/spend rotate; per-minute/model-capacity backoff; ban rotates;
  request refusal never rotates).
- ✅ **Unit — healing**: `test/providers/quota-refresh-healing.test.ts` —
  healable cooldown (quota_exhausted, null category) cleared by fresh
  healthy report; auth_invalidated never healed; active success stamp.
- ✅ **Unit — sticky**: warm window prefers sticky eligible account; explicit
  pin marked; LRU capacity eviction.
- ❌ **Unit — sibling unblock**: not implemented (no wait path).
- ❌ **Integration**: two-account provider exhaust → drain routes before the
  first fails. Covered indirectly by the routing sort tests; a live
  two-account request loop was not run.
- ❌ **Replay**: the four desktop traces were not re-run in this slice; the
  new `rotateAccount` axis is asserted by the classification unit tests only.

---

## 5. Open questions

1. **Sticky default on/off?** Implemented with a nonzero default (5 min).
   The knob exists (`CARTETHYIA_ROUTING_STICKY_WARM_MS`); set 0 to disable.
2. **Reserve default 20%?** Implemented; free-tier models bypass reserve and
   drain ordering entirely (they keep original order). Per-provider
   override is not in this slice.
3. **Does `retry-after` surface change?** Not in this slice — no timed
   provenance was ported, so the client-visible `retry-after` is unchanged.
4. **Sibling-unblock wait** is not implemented in this slice; the router
   rotates within the same rank group without a bounded sleep in the request
   path.

---

## 6. Out of scope (first slice)

- Cross-provider failover (only same-provider sibling rotation).
- Time-based pricing routing (§2.8).
- Multi-process shared reserve state (single-process first).
- Sibling-unblock wait (§2.3), block provenance/`providerTimed` (§2.4),
  usage-cache identity (§2.7), console mirror.

---

## 7. What shipped (implementation record)

Implemented end-to-end in this slice:

- **Drain-aware ordering** (`drainScore` in `drain-reserve.ts`, applied in
  `router.ts` sort): within a rank group, the account whose quota is about
  to reset unused ranks first. Computed from the same `quota_windows` the
  router already had — no new fetch.
- **Reserve demotion** (`CARTETHYIA_ACCOUNT_RESERVE_PCT`, default 20): an
  account whose remaining fraction is at/below the reserve ranks behind
  non-reserve siblings.
- **Hot-window guard**: a ≥85%-used account ranks behind cooler siblings
  even when its drain score is higher.
- **Session stickiness** (`StickySessionStore` + warm window, default 5 min;
  conversation id keyed): the account that last served a session wins within
  the warm window; explicit continuation-affinity pins win unconditionally.
  In-memory LRU, not persisted.
- **Classified rotation** (`rotateAccount` axis): quota/spend-cap/ban
  verdicts rotate to a sibling; per-minute throttles, model capacity, and
  503/529 back off on the same account — even when the wording is quota
  shaped ("tpm exhausted").
- **Healing** (`recordAccountCheck`): a successful quota refresh lifts a
  cooldown whose category is healable back to `active` immediately;
  `auth_invalidated`/policy cooldowns are never touched.

Config knobs are in `documentation/reference/configuration.md` (regenerated
from `CONFIG_SPEC`). Test coverage: `test/transport/drain-reserve-routing.test.ts`
(15), `test/providers/classification-rotate-account.test.ts` (6),
`test/providers/quota-refresh-healing.test.ts` (4). Full backend suite:
4710 pass / 0 fail; dashboard: 689 pass / 0 fail; typecheck clean.

Not in this slice (documented in §3/§5): timed/untimed block provenance,
identity-keyed usage cache, reserve/reclaim schema columns, console mirror,
sibling-unblock wait, live two-account exhaust replay, and the four desktop
trace replays.
