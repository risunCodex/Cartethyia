# Research: Telemetry volume & footprint — dev instance (2026-11-03)

Status: **research** — real data from the dev instance, repo code/docs as reference.
Goal: lower telemetry volume & footprint ("lower and lower") without breaking the
dashboard/analysis contracts.

---

## 0. Brief for the next analysis agent (handoff)

Task: analyze and propose **brutal** optimizations for the telemetry area so
volume does not grow uncontrollably (read/write are the most impactful). Data
grows ~49k rows/day; target: minimize the write path, storage, and query load
without breaking the dashboard contract.

Constraints:
- The application repo **must stay 100% in sync with upstream** — local
  patches are forbidden. Code changes are only legitimate through an
  **upstream proposal/PR**.
- What may be executed directly on the dev instance: env configuration, tenant
  settings (Settings → Privacy), scheduling/retention, and operational
  decisions.
- Secrets (passwords/tokens) and real IP/host addresses must not be written
  into documents.

Main source files to dissect (repo-relative paths):
- `src/observability/telemetry-buffer.ts` — batch/queue: flush 500ms,
  maxBatch 500, maxItems 10,000, maxBytes queue, adaptive flush (floor 50ms).
- `src/observability/raw-event-writer.ts` — dual-write JSONL + SQL.
- `src/observability/event-log.ts` — `TELEMETRY_EVENT_DIR`, line format.
- `src/observability/payload-store.ts` — frame payloads, backlog bounds
  (max 32 items / 64 MiB), default dir `./data/telemetry-payloads`.
- `src/observability/payload-capture.ts` — mode `none|metadata|full`, depth,
  payload retention (default 1 hour), state `captured` vs `captured_metadata`
  vs `skipped_*`.
- `src/observability/redaction.ts` — body redaction.
- `src/persistence/stores/telemetry-store.ts` — hourly prune, batch 5,000,
  `deleteExpiredEvents`, lifetime totals.
- `src/observability/event-query.ts` — analytics queries (summary/percentile).
- `src/console/observability/store.ts` + `src/console/settings/contracts.ts`
  — dashboard endpoints & tenant preferences `telemetryPayloads*`.
- `src/config/telemetry.ts` — env retention/payload resolution.
- `documentation/reference/configuration.md` — env list.
- `documentation/archive/proposals/persistence-console-optimization.md` —
  query optimizations already implemented (do not regress).
- `documentation/proposals/performance-resource-guard-proposal.md` —
  event-loop load & telemetry buffer floor notes.
- `documentation/architecture.md` (Data section) — write path diagram.

An export for analysis was created at one point (local, non-secret): gzip CSV
of 391,955 events; deleted after use. The raw data is still intact in the dev
instance's PostgreSQL if it needs to be re-exported.

---

## 1. Context

The dev instance was just migrated from Lite (SQLite) to Full (PostgreSQL).
After the migration & test-tenant cleanup, the active telemetry data:


| Data | Count |
| --- | --- |
| `telemetry_events` | 391,955 rows (7 days: Oct 27 – Nov 3) ≈ **49k/day** |
| `telemetry_usage_totals` | 1,186 rows (lifetime) |
| `telemetry_payloads` | 299 rows (frame index still within retention) |
| Average event row size | ~367 bytes (raw ~144 MB) |

## 2. Event content shape (averages)

- **Surface:** 97% `chat`, 3% `messages`/`responses`; ~96% of endpoints on
  `/v1/chat/completions`.
- **Status:** 94.6% `completed`; 4.4% `failed`; ~1.2% `cancelled`.
- **Error:** 94.6% of rows have no `error_category` (success). Top errors:
  `accounts_rate_limited`, `transport_closed`, `authentication_failed`,
  `platform_unavailable`.
- **Payload capture:** 70% `captured` (full), 27% `captured_metadata`,
  ~3% with no state. **No** `skipped_mode_none` → the active tenant uses full
  capture mode.
- **Latency:** median ~4.5s; mean ~8.9s; tail up to ~15 minutes
  (investigation: `transport_closed` / upstream timeout).
- **Tokens:** input average ~122,938, output ~753 (large-context dominance,
  code-completion style).
- **Accumulated cost:** ~US$2,942 (7 days).

## 3. Write path architecture (summary, from docs + code)

```
per-request event ──► hourly JSONL file (data/telemetry-events/<hour>-<writer>.jsonl)
                ──► telemetry_events (SQL row)          — analytics source
                ──► telemetry_usage_totals (lifetime)
payload (if full/metadata) ──► frame file + telemetry_payloads index
```

- `TelemetryBatchBuffer`: multi-row batch insert, default flush interval
  **500 ms**, `maxBatch` 500, `maxItems` 10,000, `maxBytes` per bounded queue;
  adaptive flush (floor 50 ms when the queue is full).
- **Retention:** hourly prune (`telemetry-store.ts`): deletes JSONL files & SQL
  rows whose hour is older than the retention (the current hour + previous one
  are untouched). `deleteExpiredEvents` in batches of 5,000.
- **Payload:** live frames default to **1 hour** (`payloadRetentionMs`),
  overridden by the `CARTETHYIA_TELEMETRY_PAYLOAD_MAX_BYTES` config
  (default 16 MB). The `telemetry_payloads` index only holds frames still
  within the window.

## 4. Available configuration (docs configuration.md)


| Variable | Default | Range |
| --- | --- | --- |
| `CARTETHYIA_TELEMETRY_RETENTION_DAYS` | 30 | 3–365 |
| `CARTETHYIA_TELEMETRY_PAYLOAD_MAX_BYTES` | 16,777,216 | 1,048,576–16,777,216 |
| `CARTETHYIA_TELEMETRY_PAYLOAD_RETENTION_MS` | 3,600,000 | 1,000–604,800,000 |
| `CARTETHYIA_TELEMETRY_PAYLOAD_DIR` | (outside the spec) | — |

Capture mode/depth config does **not** go through env; it goes through
**Settings → Privacy** per tenant (`telemetryPayloads`: `none` | `metadata` |
`full`; `telemetryPayloadDepth`: minimum/moderate/maximum;
`telemetryWindowMinutes`).

## 5. Findings & savings opportunities

### P-1 (biggest): full capture mode → metadata/none
- 274k `captured` rows = frames containing the (redacted) request & response
  bodies written to disk + per-request I/O.
- Switching the tenant to `metadata` (keeping only Proxy→Provider rows) or
  `none` removes body frames entirely; **event rows remain intact** in SQL.
- This is the biggest disk/I-O cut, with no impact on analytics.
- Implementation: directly through the dashboard Settings → Privacy (tenant
  config, not env).

### P-2: shorten retention for dev
- Default 30 days. For dev, `CARTETHYIA_TELEMETRY_RETENTION_DAYS=7` is enough;
  lifetime history stays safe in `telemetry_usage_totals`.
- Effect: automatic hourly prune cleans SQL + files more aggressively.

### P-3: lower the payload cap
- `CARTETHYIA_TELEMETRY_PAYLOAD_MAX_BYTES=1048576` (1 MB) → smaller frames,
  less disk per capture.
- Combine with P-1 if full capture is still occasionally needed.

### P-4: evaluate the JSONL double-write
- Every event is written **twice** (SQL + JSONL). JSONL is rough audit/retention;
  analytics reads SQL. If the file audit is not needed for dev,
  disabling raw JSONL could be proposed (requires a code change;
  no env toggle yet).

### P-5: aggregation & archive instead
- The `telemetry_usage_totals` key already holds lifetime numbers. For dev,
  raw events past retention are already trimmed automatically — just make sure
  retention is set to the required value (P-2).

### P-6: not a savings target
- `client_ip`/`user_agent` are not dominant in row size (367 B/row is already
  light). Don't-touch.

## 6. Risk notes

- The dashboard request-list & detail drawer read JSONL frames; disabling full
  capture degrades the detail drawer to "metadata only" (by design).
- Retention trims by **hour**, not full days; a `RETENTION_DAYS` setup
  is interpreted as an age limit, safe for consistency.
- Do not change the `telemetry_events`/`telemetry_usage_totals` contract — it is
  used by `event-query.ts` + the dashboard `usageSummary`/`health`.

## 7. Execution recommendations (dev)

1. **Immediately:** in Console → Settings → Privacy, set the active tenant →
   capture `metadata` (or `none`), depth `minimum`, window 60 minutes.
2. **Immediately:** dev `.env` → `CARTETHYIA_TELEMETRY_RETENTION_DAYS=7` +
   `CARTETHYIA_TELEMETRY_PAYLOAD_MAX_BYTES=1048576`, restart the app.
3. Re-measure after 24–48 hours: events/day, DB size, PakaiCloud disk.
4. (Optional code proposal) capture sampling, disabling raw JSONL, and daily
   rollups if the volume target still needs to be lowered.
