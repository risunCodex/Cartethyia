# Proposal — Proxy pool routing transparency: surface the selection mode

Status: implemented (see `c0e93b56` — pool strategy surfaced in the dashboard)
Owner skill when implementing: `.skills/cartethyia-health-routing/`, `.skills/cartethyia-dashboard/`
Owner areas: `src/console/routing/pools/` (store, operations, routes), `src/network/pool/selector.ts`,
`dashboard/src/features/provider-detail/sections/RoutingStrategyCard.tsx`,
`dashboard/src/features/proxy/`, `dashboard/src/hooks/network.ts`.
Triggered by operator report: the routing card gives no way to see or choose how
a provider's proxy pools are selected — the operator knows only "Always direct"
(off/on) and otherwise has to trust that the system "knows best". The pool
selection mode exists in the backend today but is invisible.

---

## 1. Audit — what exists today (traced, not assumed)

### 1.1 Backend has a complete pool-routing setting, with no UI

- Table `pool_routing_settings` (per tenant, visible in `schema.ts`): `strategy`
  + `rotateCount`.
- Contract (`src/console/routing/pools/contracts.ts:225`):

  ```ts
  export const POOL_ROUTING_STRATEGIES = ["least_loaded", "round_robin", "random"] as const;
  export const DEFAULT_POOL_STRATEGY = { strategy: "least_loaded", rotateCount: 1 };
  ```

- Routes already exist:
  - `GET /routing/pools/strategy` → `store.getStrategy(tenantId)` (defaults to
    `DEFAULT_POOL_STRATEGY` when no row exists — `operations.ts:125`).
  - `PUT /routing/pools/strategy` → validates `strategy` ∈ enum and
    `rotateCount` ∈ `1..1000`, writes the row, invalidates the route snapshot,
    and audits `network_pool.strategy_updated` (`operations.ts:129`).
- The selector honors all three strategies in
  `src/network/pool/selector.ts` (`tryAcquireAvailablePool`):
  - `least_loaded` (default): weighted least-loaded scan with fairness cursor,
    headroom failover, and provider-per-pool ceiling checks.
  - `round_robin`: strict rotation from a tenant cursor, `rotateCount` successful
    admissions per pool before the cursor advances; full/cooling pools fall
    through (failover preserved).
  - `random`: Fisher–Yates shuffle of eligible pools each request, then admit
    loop with the same failover.
  - All strategies share the same gates: provider cooldown markers, capacity,
    weight, provider ceiling, and the return `undefined` → `proxy_pool_*`
    error when every pool is spent.
- Route catalog (`route-catalog.ts`) already threads `network_pool_routing`
  onto pool-account candidates when a `pool_routing_settings` row exists; an
  absent row reads as `DEFAULT_POOL_STRATEGY` at selection time.

### 1.2 The dashboard has zero visibility into it

- `RoutingStrategyCard.tsx` (provider detail) renders **provider-level** routing
  only: round-robin over *accounts*, "Always direct" (`skipProxy`), client
  identity, max inflight/account, max inflight/proxy. Nothing about pools.
- `ProxyPage.tsx` lists pools, probes, speed-tests, health — but never exposes
  the tenant's pool selection mode.
- `dashboard/src/hooks/network.ts` exports `useNetworkPools` etc. but no
  `usePoolStrategy` hook; `assertPoolStrategy` exists in `data/assert.ts` and
  is unused by any component.
- Consequence: the operator cannot know whether traffic is being spread by
  least-loaded scoring, rotation, or randomness — nor change it. Defaults
  ("least_loaded") are invisible and silently assumed.

### 1.3 "Direct" is a separate lever

- `skipProxy` ("Always direct" switch) lives in provider routing settings.
  When on, no pool is dialed; when off (default), the candidate carries
  `network_pool_ids` and selection follows the pool strategy above. The card
  already explains this accurately — the gap is not the switch, it is the
  absence of the *mode* that governs the pooled path.

---

## 2. Direction (operator's idea, endorsed)

Give the operator **transparency and control over pool selection mode** in the
routing card, plus a read-only "what will this request do" summary. The backend
is done; this is a pure dashboard surface + one new hook + a docs touch.

Design principles:

1. **One control, three modes** — a Select in the routing card: *Least loaded*
   (default), *Round robin*, *Random*. Matches `POOL_ROUTING_STRATEGIES`
   exactly; nothing new on the backend.
2. **Reveal the dependent setting only when relevant** — `rotateCount`
   (accounts per rotation) shows only when *Round robin* is active, using the
   same +/- stepper pattern already used for the provider round-robin count.
3. **Transparent state, always visible** — a compact "Routing" summary line in
   the card reads e.g. `Pool mode: least loaded` or
   `Pool mode: round robin · 2 per rotation` or `Direct — no pool dialed`
   when `skipProxy` is on, or `Pool mode: — (no pools configured)` when the
   tenant has no active pool for the provider.
4. **Explain what it means, not just what it is** — a `?` / chevron opens a
   small dialog (same pattern as the existing "How concurrency limits stack"
   dialog) that explains each mode in one line + when it matters (bursts,
   fairness, provider cooldowns).
5. **Request-level transparency (optional follow-up)** — a "Last request
   route" line in Request Detail already shows the pool label (`networkPoolId`);
   extend it with the strategy *in force at that time* by persisting the strategy
   name into the telemetry event (next to `networkPoolId`). This is a separate,
   optional step that requires a telemetry field + query — listed separately so
   the core UI work ships without it.

---

## 3. Design

### 3.1 New hook — `usePoolStrategy()`

`dashboard/src/hooks/network.ts`:

- `usePoolStrategy()` → `useQuery` on `queryKeys.network.poolStrategy`
  (`["console", "network", "pool-strategy"]`), `queryFn` → `GET
  /routing/pools/strategy`, validated with `assertPoolStrategy`.
- `useUpdatePoolStrategy()` → `useMutation` → `PUT /routing/pools/strategy`,
  invalidates the strategy query + the route snapshot (backend already does the
  snapshot invalidation; the query invalidation keeps the card fresh).

Contract types already exist (`PoolStrategySetting` imported in
`dashboard/src/data/contracts.ts`).

### 3.2 Routing card additions (`RoutingStrategyCard.tsx`)

Place a new `Row` between the "Always direct" row and the concurrency grid:

```
[Pool selection]        [ Select: Least loaded | Round robin | Random ]
  Proxy pools are chosen by this mode when "Always direct" is off.
  [rotateCount stepper — only when Round robin is selected]

[? How pool routing works]  → dialog (mode explanations)
```

States:

| State | Control | Summary line |
|---|---|---|
| `skipProxy` = on | Select disabled | `Direct — proxy pools bypassed` |
| no pool configured for provider | Select enabled | `No proxy pool configured — provider dials direct` |
| mode = least_loaded | Select | `Pool mode: least loaded` |
| mode = round_robin | Select + rotateCount stepper | `Pool mode: round robin · N per rotation` |
| mode = random | Select | `Pool mode: random` |

Behavior:

- Saving: debounced like the other routing fields; on error, revert to last
  saved value and toast (existing pattern in `useRoutingStrategy`).
- The summary line replaces the current subtitle only when a pool is involved?
  No — keep the existing subtitle ("Active: …") for provider routing and add a
  *separate* line for pool mode so the two do not conflate. The card is already
  title "Routing Strategy"; the pool line is one more visual row.

### 3.3 Proxy page top bar (read-only)

Add a small read-only chip/line in `ProxyPage.tsx` next to the "Add proxy"
button or in the table header row: `Pool routing: least loaded` (or
`round robin · 2`, `random`). No control here — one place to see it, the card
is where it is changed. Reuses `usePoolStrategy()`.

### 3.4 Dialog — "How pool routing works"

Same pattern as "How concurrency limits stack". Three entries:

- **Least loaded** — each request goes to the pool with the most headroom
  (weighted). Best default for mixed workloads; spreads load and prefers the
  fastest-available egress.
- **Round robin** — requests rotate across pools in a fixed order, `N`
  successful requests per pool before moving on. Useful when you want even
  *counts* per pool rather than load-based distribution.
- **Random** — each request picks from the eligible pools at random. Useful to
  spread bursts that would otherwise gang up on the first pool in the order.

Plus a line: all modes skip pools that are cooling down (provider rate-limit),
full, or disabled — the pool's own gates apply regardless of mode.

### 3.5 Backend changes

None required for the core feature. Optional:

- `GET /routing/pools/strategy` already returns the effective default when no
  row exists — confirm the dashboard displays the *effective* value (good) and
  does not fake a saved one.
- Optional follow-up (transparency of the *past*): persist the strategy name on
  the telemetry event (`networkPoolId` already exists) and render it in Request
  Detail. Needs a new column/field + query mapping + drawer line — scope it
  separately.

---

## 4. Files touched

| File | Change |
|---|---|
| `dashboard/src/hooks/network.ts` | add `usePoolStrategy`, `useUpdatePoolStrategy` |
| `dashboard/src/features/provider-detail/sections/RoutingStrategyCard.tsx` | add pool-mode Select + rotateCount stepper + summary line + dialog |
| `dashboard/src/features/proxy/ProxyPage.tsx` | read-only "Pool routing: …" chip |
| `dashboard/src/data/query-keys.ts` | `poolStrategy` key already present — reuse |
| `documentation/reference/` (optional) | note the strategy setting + endpoints |

## 5. Validation

- Typecheck both trees, dashboard build.
- Component-level: `RoutingStrategyCard` renders the right control per state
  (skipProxy on/off, no pools, each mode) with the existing test harness if one
  is added; otherwise verify via the agent-browser against a local gateway.
- API: `PUT /routing/pools/strategy` round-trip (set round_robin/3, read back,
  verify card reflects it), invalid strategy rejected (400), `rotateCount` out
  of range rejected.
- Routing behavior unchanged: selector logic is untouched; the UI only reads and
  writes the existing setting.

## 6. Out of scope (noted for later)

- Per-request strategy telemetry (3.5 optional).
- Per-pool selection override (strategy per pool), if ever wanted — today the
  mode is tenant-wide.
- Availability/failover history in the UI (pool list already shows health; the
  mode is orthogonal).
