# Proposal — OpenCode pool health unification ("Proxy Account Pool")

Status: proposed — not yet implemented
Owner skill when implementing: `.skills/cartethyia-health-routing/`
Owner areas: `src/transport/routing/`, `src/network/`, `src/providers/discovery/probing-service.ts`,
`src/console/routing/pools/`, `dashboard/src/features/proxy/`, provider detail accounts UI.
Triggered by operator report: proxy-page OpenCode test reads `27 allowed · 0 blocked ·
18 rate-limited`, but dispatch continues dialling the rate-limited egresses.

---

## 1. What is actually broken (traced, not assumed)

1. **The probe's `throttled` verdict reaches nothing.**
   `src/console/routing/pools/store.ts` persists the probe verdict to
   `network_pools.provider_probe_status` (badge + tests only). Boot restores **only
   `blocked`** verdicts into the selector (`restorePoolProbeVerdicts`,
   `src/network/pool-cooldown-store.ts:220`, guard at line 238). A `429` verdict is
   therefore invisible to dispatch: the operator's test proves an egress is spent,
   and routing still spends a real upstream request on it at the next dispatch
   before *dispatch's own* 429 flags the cooldown.
2. **Dispatch-learned cooldowns work — probe-learned ones do not.** A real 429
   on an `ipScopedRateLimit` provider goes
   `shouldCooldownPool` → `flagPoolCooldown(selector, db, poolId, providerId)`
   (`attempt-loop.ts:393`), local map synchronous, Redis mirrored, restored at
   boot. The gap is only "probe knows, dispatch doesn't".
3. **One 429 is classified in four separate vocabularies:**
   - dispatch: `shouldCooldownPool` / `isFreeTierIpBlock` (`retry-policy.ts`)
   - console probe: `classifyProviderProbeAnswer` (`probe-verdict.ts`, own enum
     `allowed | blocked | throttled | unreachable`)
   - account health: `account-error-classification.ts` (`rate_limit_transient`, …)
   - pool health machine: `active | cooldown | disabled` statuses
   The statuses can and do disagree (probe badge says throttled; proxy page says
   nothing; account health never hears of it).

## 2. The direction (operator's idea, endorsed with one sharpening)

Treat each egress as an **account-equivalent routing entity** for providers whose
limits follow the IP (`ipScopedRateLimit` — opencode today). The skill note in
`retry-policy.ts` already states the principle: "the upstream counted requests
from this address, so the pool is the thing that ran out". Making the pool a
**proper routing entity** lets one health pipeline own it:

- probe verdicts and dispatch failures feed **one** health owner;
- `plan()` excludes/deprioritizes spent egresses **before dialing** (cooldown
  classes, hard/soft, reset times become `429 accounts_rate_limited` answers);
- the proxy page, provider-detail accounts UI, and health pages speak the same
  taxonomy instead of three;
- usage/telemetry attribute per egress like it attributes per account.

Concretely: a **`pool accounts` migration** that materializes one
tenant-scoped pseudo-account row per (network pool × ip-scoped provider), named
**Proxy Account Pool** in the UI. Account health, sweeps, cooldown classes, and
quota read it like any account; the dial-time pool selector keeps its
connection slot logic but stops being a second source of truth.

## 3. Design

### 3.1 Step 1 — one verdict classifier + probe feeds routing (no migration)

New module `src/network/rate-limit-verdict.ts`:

```
type EgressVerdict =
  | { kind: "allowed" }
  | { kind: "throttled"; resetAt?: Date; reason?: string }
  | { kind: "blocked"; reason: string }
  | { kind: "unreachable"; reason: string };
classifyUpstream429(status, payload, providerId): EgressVerdict   // ip-scoped-aware
classifyUpstream403FreeTier(payload, providerId): EgressVerdict   // moved from retry-policy
```

- `retry-policy.ts`'s `shouldCooldownPool` / `isFreeTierIpBlock` are **replaced**
  by this module at both call sites (attempt-loop, and any future ones). Cutover
  complete — no compatibility shims.
- `probe-verdict.ts` becomes a thin adapter over the same classifier: the
  console enum derives from `EgressVerdict.kind`. The dashboard keeps its copy;
  it renders server state, it does not own the enum.
- The probe store, after persisting the probe row, applies the verdict through
  the **same** selector path dispatch uses (`flagProviderCooldown` with the
  upstream's stated window, or `flagProviderBlocked`). The read-only rule stays
  for `allowed`; a `throttled`/`blocked` probe writes the same fact a dispatch
  failure would prove — the operator test acts on what it observed, which is
  exactly the operator's expectation today.
- Boot restoration also replays `throttled` markers, not just `blocked`.

This alone removes the reported symptom and the wasted-request cost. It is
ship-first and valuable on its own.

### 3.2 Step 2 — Proxy Account Pool entities (migration)

**New migration (next number, both dialects — owned by
`.skills/cartethyia-schema-telemetry/`):** table `provider_pool_accounts`:

```
id (uuid pk)
tenantId (fk tenant, matches pool.tenantId — nullable global pool ⇒ global row)
networkPoolId (fk network_pools, cascade delete)
providerId (text — always ip-scoped; enforced by app, checked by sweep)
credentialKind: "egress" (not api_key/oauth — fixed)
status: active | cooldown | disabled   (account-health owns transitions)
cooldownUntil, cooldownKind (hard|soft), lastErrorCategory
authState jsonb — per-egress bookkeeping (last 429 reset, probe verdict mirror)
createdAt, updatedAt
unique (networkPoolId, providerId, tenantId?)
```

Wiring:

- **Backfill**: one row per existing pool × `IP_SCOPED_RATE_LIMIT` providers
  (today only `opencode`), generated in the migration, and kept in sync when
  pools are created/imported/deleted (store hooks in
  `src/console/routing/pools/store.ts` + catalog rebuild).
- **Route catalog**: for `requiresAccount === false && ipScopedRateLimit`,
  `route-catalog.ts` stops emitting the single multi-pool candidate and emits
  one candidate per pool-account (pool bound, `requires_account: false` still —
  the dial is identical), with the pool-account's health driving
  `cooldown_kind` at plan time exactly like real accounts.
- **Health owner**: `account-health-service.ts` accepts pool-account entities.
  A dial-time 429 on an ip-scoped provider records `rate_limit` cooldown on the
  pool-account (through the classifier from step 1) — the selector's per-pool
  cooldown map becomes the *execution cache* it dereferences at acquire, with
  the pool-account row as the durable home. One writer; the mirror stays.
- **Probe**: a probe against a pool runs per ip-scoped provider and records the
  verdict on the pool-account (health event, `entity_kind: "pool_account"`) in
  addition to the badge columns.
- **Quota/usage**: websearch/telemetry attach pool-account id where accounts
  attach account id, so Usage attributes traffic per egress.
- **Dashboard**: provider-detail accounts list shows pool accounts with a
  "Pool" kind badge sharing the existing status components (mutually exclusive
  statuses per the skill's UI rule); proxy page keeps its pools table but the
  cooldown badge reads the same columns the account view does.

### 3.3 Invariants to keep (per the health-routing skill)

- `blocked` (free-tier IP refusal) stays a far-future retirement, not a timed
  cooldown; restored at boot.
- A 429 window is a **soft/hard cooldown per classifier**, never a pool
  `status` flip.
- Non-ip-scoped providers are untouched: their 429 stays account-scoped; the
  backstop guard in `flagProviderBlocked` remains.
- 429-on-all → `429 accounts_rate_limited`; unavailable → `503
  accounts_unavailable` (now covering exhausted egresses too).
- Deleting a pool cascades its pool-account rows and clears cooldowns
  (`clearPoolCooldowns` already exists).
- Backup/restore round-trips the new table (add to the backup contract's
  config tables + nine-router projection only if relevant).

## 4. Effort

| Step | Content | Sessions |
|---|---|---|
| 1 | `rate-limit-verdict.ts` cutover + probe write-through + throttled boot replay + tests (classifier unit + one dispatch-path test) | ~1 |
| 2 | Migration + store hooks + catalog candidates + account-health + UI badge/quota wiring + backend suites | ~3–5 |

Step 1 ships separately and fixes the report; step 2 is the real unification
and can follow without churn in 1's code.

## 5. Open decisions for the next session

1. Table name (`provider_pool_accounts`) — or widen later to "egress accounts"?
2. Selection UI: pool accounts shown inside the provider's accounts tab (same
   list as real accounts, badge "Pool") vs a separate sub-tab?
3. Whether a pool-account *disabled by the operator* (not upstream) must also
   disable the pool row for every other provider it serves — proposed: no,
   per-provider independence holds.

---

*Evidence touchpoints: `src/transport/dispatch/attempt-loop.ts:369-400`,
`src/transport/dispatch/retry-policy.ts:40-99`, `src/network/pool-cooldown-store.ts:220-238`,
`src/network/pool/selector.ts:329-390, 580-689`, `src/console/routing/pools/store.ts:340-391`,
`src/console/routing/pools/probe-verdict.ts`, `src/transport/routing/route-catalog.ts:646-699`,
`dashboard/src/features/proxy/ProxyPage.tsx:364-422`.*
