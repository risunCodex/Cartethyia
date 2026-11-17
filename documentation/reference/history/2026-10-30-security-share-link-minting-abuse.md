---
title: Share-link minting abuse — incident analysis & prevention
date: 2026-10-30
tags: [incident, security, share-link, abuse, history]
category: history
severity: high
status: mitigated
---

# Share-link minting abuse — incident analysis & prevention

> Status: research/incident record (2026-10-30). Data captured live from the
> dev deployment before & after the cleanup. This file is a **historical
> record** — kept in `reference/history/`, not linked from active reference
> documents.

## 1. Incident summary

A single share template ("One step at a time", `e58be58d-…`) was used to
**bulk-mint child keys** by a bot script:


| Phase                      | Removed count | Notes                                                                          |
| -------------------------- | ------------- | ------------------------------------------------------------------------------ |
| 2 Google Cloud IPs (edge)  | **319,395**   | `35.247.128.192` (287,675) + `35.194.181.114` (31,720), created within \~3 days |
| Remainder (12,327)         | **12,327**    | 12,204 zero-usage (99%), 123 previously used, 54 hits today                     |
| **Total**                  | **331,722**   | \~99.9% never used                                                             |


Both waves displayed the same bot pattern:

- **Millisecond bursts**: hundreds of keys created in the same second (e.g. `05:56:41.396–419`).
- **Synthetic labels**: `omp-<random>` (and other variants) — not human-written hint names.
- **Edge/rotating IPs**: behind CDN/cloud edge (IPv4 &amp; IPv6) and proxy/residential; per-IP dedupe does not hold because every request arrives from a different edge/rotating IP.
- **Zero usage**: 99%+ never issued a single request.
- IP distribution of the remainder (12,327): `126.209.124.215` (4,407) &amp; `126.209.124.217`
(1,499) — Indonesian ISP range; `104.28.194.105` (3,175) — Cloudflare IPv4
edge; `2a09:bac5:…:247:aa` (3,110) — Cloudflare IPv6 edge; ~105 other IPs
with 1–6 keys each (total ~136). Same pattern: millisecond bursts + `omp-*` labels.

Consequences:

- `api_keys` swelled by 330k+ rows → storage/backup bloat (367 MB raw), broad authentication reads, the console list briefly went missing/erroring (e.g. `IN (...)` passing PG's 65,535 bind-param limit).
- Policy drift risk &amp; administrative noise.

## 2. Attack surface

Route `POST /share/:token/issue` (`src/console/share/share-router.ts:358`)
creates a child with a **single dedupe key**: 1 child per canonical client IP
(`canonicalClientIpKey`). That is enough for an ordinary human, but it **fails
against**:

1. **IP rotation / proxy / CDN masking** — the attacker uses many edge IPs
 (GCP, Cloudflare, etc.); each IP gets 1 child → no total limit.
2. **No total limit per template** — without a cap, the child count is
 unbounded.
3. **No proof-of-humanity** — `issue` is a public endpoint with no CAPTCHA
 / challenge / session token.
4. **No global rate limit per link** — throttling is per-IP only.
5. **No anomaly/alerting** — a 330k mint spike is not detected
 automatically.
6. **No hygiene** — children that are never used are never
 recycled.

## 3. Prevention recommendations (in priority order)

### Phase 1 — fast, high impact, low risk

1. **Hard cap on children per template** (default e.g. 200–500, configurable
 per tenant). In `issueSharedApiKey`, count the template's active children; if
 `>= cap` → reject with `429`/`conflict` + flag the template in the console.
 This closes the root cause (unbounded) immediately.
2. **Rate limit per template + window** (Redis counter, mirroring the
 `pruneTelemetry`/admission pattern): e.g. ≤30 mints/minute per link; a second
 limit per IP. Anti-burst even before the cap is reached.
3. **Hygiene worker**: purge children where `created_at < now() - interval '30  days'` **and** `lifetime_tokens_consumed = 0` **and** there is no telemetry
 (batch 5000, mirroring `deleteExpiredEvents`). Ensures even small leaks do
 not pile up.

### Phase 2 — deeper hardening

4. **Trust Cloudflare true client IP**: add Cloudflare CIDRs to
 `TRUSTED_PROXY_CIDRS` and read `CF-Connecting-IP` → per-IP dedupe
 becomes effective again even via CDN (tighten so only trusted CF
 sources are accepted). Do not do this without verifying proxy-trust security.
5. **Light challenge on the share page** (honeypot field + minimum time +
 one-time HMAC session token signed when the page renders; `issue`
 rejects without the token). Blocks scripts without browser interaction.
6. **Anomaly &amp; alerting**: metric `mint rate per template/minute`; alert at a
 threshold (e.g. &gt;50/minute); optional auto-pause of the link (`share_links.active=false`)
 when detected, with a console notification.
7. **Audit &amp; visibility**: count children per template in the console + log
 `api_key.share_minted` (an audit sink already exists; make sure bulk mints are recorded),
 and show mints per hour on the share page.

### Design notes

- The cap &amp; rate limit must live in the **store/route layer** (not just the UI).
- With a cap, the load on `listChildrenPage` is automatically bounded as well; however, keep
 the pagination that was just built (recipients table).
- Backup/restore: templates with few children → exports are far smaller;
 make sure the cap does not block restoring old backups (restore does not run
 the cap — the cap only applies to new mints).

## 4. Code references

- Mint child: `src/persistence/stores/share-store.ts` (`issueSharedApiKey`).
- Public route: `src/console/share/share-router.ts:358` (`POST /share/:token/issue`).
- Per-IP dedupe: `canonicalClientIpKey` (share-store / share-router).
- Precedent batching: `src/persistence/stores/telemetry-store.ts:316` (`deleteExpiredEvents`).
- Child list pagination: `src/persistence/stores/api-key-store.ts` (`listChildrenPage`).
- Readiness/ledger: `src/persistence/migrate.ts`.

## 4b. Follow-up finding: total usage inconsistency

After the cleanup, the family usage numbers were inconsistent across surfaces:


| Surface                        | Source                                                                 | Value (for the One step at a time template) |
| ------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------- |
| Overview / key list            | the `api_keys.lifetime_tokens_consumed` column **on the template**     | **400,000,000,000 (400B)**                  |
| Share page `/stats`            | `telemetry_usage_totals` family (including deleted children)           | \~15.6B                                     |
| Share dialog / recipient table | the `lifetime_tokens_consumed` column on the **remaining children** (3) | \~1.8M                                      |


Root cause: (1) the template counter column holds a 400B value (seeded/manual, not
produced by traffic), and (2) `telemetry_usage_totals` stores a row per child
that is not deleted when the child is removed → the telemetry total still
covers the cleaned-up bots. The three sources read different columns/tables,
so they always appear contradictory.

Recommendation: unify the definition of "total family usage" in a single source (e.g.
`telemetry_usage_totals` for the surviving family, pruning rows of deleted
children, or summing the columns of the remaining children), and clarify
the template counter column as a seed limit — not usage output.

## 5. Action status

- [x] Done and all Mitigated!
