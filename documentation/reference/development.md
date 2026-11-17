# Development reference

Developer-facing facts that do not belong to one feature page: the measured
size of the tree, the four model-name forms (and how mixing them up produces
confident wrong conclusions), and the measured parity between the two
persistence backends.

Contents:

- [Codebase size](#codebase-size)
- [Model name forms](#model-name-forms)
- [Persistence parity](#persistence-parity)

---

## Codebase size

Working-tree snapshot on 2026-11-17, regenerated with the script below. The
backend is `src/`; the frontend is `dashboard/src/`, matching the ownership
boundary in [Architecture](architecture.md). Line counts drift while source
work is in progress — rerun the script for a fresh snapshot.

| Area | Files | Source lines | Nonblank lines |
| --- | ---: | ---: | ---: |
| Backend | 756 | 186,924 | 177,030 |
| Frontend | 190 | 51,283 | 48,910 |
| **Total** | **946** | **238,207** | **225,940** |

Source lines count physical lines in tracked files under those directories,
matching the script below (`.ts/.tsx/.js/.jsx` plus the stray stylesheet and
SQL assets the dashboard carries). Nonblank lines omit
empty or whitespace-only lines but still include comments. Tests, generated
assets, dependencies, scripts, migrations outside `src/`, and documentation
are not included. These are repository-size estimates, not language-aware
logical LOC; rerun the count after source changes for an updated snapshot.

To reproduce:

```sh
for area in src dashboard/src; do
  files=$(git ls-files "$area" | grep -E '\.(ts|tsx|js|jsx|css|scss|html|sql)$')
  echo "$area files=$(echo "$files" | wc -l)" \
       "lines=$(echo "$files" | xargs wc -l | awk '{if ($2=="total") s+=$1} END {print s}')" \
       "nonblank=$(echo "$files" | xargs grep -cvE '^\s*$' | awk -F: '{s+=$2} END {print s}')"
done
```

---

## Model name forms

Four different strings get called "the model" when debugging a request. Mixing
them up produces confident wrong conclusions, so this section fixes what each
one means and where it comes from.

### The four forms

| Form | Example | Who writes it |
|---|---|---|
| Requested | `bansos/deepseek-v4.1-flash(max)` | the client |
| Canonical (bare) | `bansos/deepseek-v4.1-flash` | `parseThinkingSuffix` |
| Routed candidate | `deepseek-v4.1-flash` | routing, from `RouteCandidate.model_id` |
| Displayed | `bansos/deepseek-v4.1-flash (max)` | the Request Detail view |

### The effort suffix: `(max)` vs ` (max)`

**The space matters, and it is not cosmetic.**

- `model(max)` — **no space** — is the syntax a client actually sends. It is a
  supported feature: a thinking-effort level carried in the model name.
  `parseThinkingSuffix` (`src/protocol/translation/thinking.ts`) strips it
  before anything reads the model name, because alias resolution, the
  allowlist, the prefix check, and routing all match against registered ids and
  a name carrying `(max)` would fail every one of them. It is stripped on the
  canonical request, not in a provider adapter, which is what makes the syntax
  global: at that point no provider has been chosen yet.
- `model (max)` — **with a space** — is never sent by a client. It is the
  gateway's own annotation in the Request Detail view: the recorded model name
  beside the effort level it detected. Treat the space as the marker for "this
  string is display, not wire".

So `bansos/deepseek-v4.1-flash (max)` in Request Detail means the client asked
for `bansos/deepseek-v4.1-flash(max)`. Do not read the space as a client bug,
and do not paste the spaced form into a replay — it will not resolve.

`formatThinkingSuffix` is the documented inverse of the parser and emits the
**spaceless** form (`model(level)`). It is currently used only by the provider
detail model probe (`Models.tsx`); the Request Detail annotation reaches its
spaced form by another path, so do not assume the two share an implementation.

### The prefix is stripped before dispatch, and that is correct

A client sends `bansos/deepseek-v4.1-flash`. Upstream receives
`deepseek-v4.1-flash`. That is **not** a bug and must not be "fixed".

`bansos` is not a provider — it is a **combo name**. Combos are tenant-scoped
records (`/console/api/routing/combos`) that expand to member models served by
real providers, for example:

```
bansos/deepseek-v4.1-flash -> ["cb/deepseek-v4.1-flash", "cbcn/deepseek-v4.1-flash"]
```

Routing resolves the combo, expands its members, and picks a candidate. Every
dispatch path then sends `candidate.model_id`, which is the **bare** model id,
with `provider_id` held separately on the candidate. Upstreams have never seen
and must never see the combo prefix.

The consequence for debugging: **a missing prefix in `providerRequest` is
normal**. Compare the requested name against the candidate's provider instead
of expecting the prefix to survive.

### When a prefix is a real bug

The prefix is only meaningful as a combo name or a provider id. It stops being
meaningful when:

- **the combo does not exist.** `bansos/claude-sonnet-5` is not a registered
  combo, so `candidateMatches` looks for a provider literally named `bansos`
  and finds none: `model_not_found`, `errorOrigin: cartethyia`,
  `providerId: null` — the request never reached a provider. The same model
  under its real provider (`github/claude-sonnet-5`) resolves and fails as
  `accounts_unavailable` instead. Different error, different owner.
- **the tenant does not match.** Combo lookup is
  `snapshot.combos[tenantId]?.[resolvedModel]`. A null or wrong tenant id
  yields no combo map, so the requested name is used verbatim and the prefix is
  treated as a provider id — the same failure as above.
- **a member has more than one slash.** `parseModelReference`
  (`src/transport/routing/candidate-index.ts`) splits on the *first*
  slash only, so `cline/cline-free/mimo-v2.6-flash` is provider `cline` with
  model `cline-free/mimo-v2.6-flash`. That matches how the catalog stores it,
  but it means a nested-looking id is not a nested route.

### Reading a failure

- `errorOrigin: cartethyia` + `model_not_found` + `providerId: null` — routing
  rejected it before any provider was involved. Suspect the name, the combo
  registration, or the tenant scope; not the upstream.
- `accounts_unavailable` — the name resolved and combo expansion worked; no
  account in the pool can serve it right now. A routing or payload bug is ruled
  out by this error alone.
- An upstream `4xx` with the bare model id — the prefix stripping was correct;
  bisect the payload instead.

To see what the instance can actually route, compare `/v1/models` against
`/console/api/routing/combos`. They are not the same list: a combo can be
registered yet absent from `/v1/models` when no account can serve it.

---

## Persistence parity

Both persistence backends — embedded SQLite (Lite mode) and PostgreSQL (Full
mode) — run the same Drizzle schema (`src/persistence/schema.ts`, written with
`pg-core`) and the same stores. Parity is a maintained property, not an
accident: SQL expressions that differ live in `src/persistence/dialect.ts`,
the SQLite baseline is generated from the PostgreSQL baseline by
`scripts/tools/generate-sqlite.ts`, and on top of `0000_baseline.sql` both
backends carry the same numbered forward migrations under
`migrations/full-postgres/` and `migrations/lite-sqlite3/` (e.g.
`0001_allow_multiple_shared_keys_per_ip.sql`).
`test/persistence/sqlite-baseline.test.ts` checks that inventory, generated
output, and runtime constraints. Existing databases with retired migration
history are recreated and restored from backup, not upgraded in place. What
follows is what that arrangement actually does, measured against a real SQLite
database on 2026-10-07, not inferred from the types.

The column counts are from `schema.ts` (measured on 2026-11-02): 20
`boolean`, 23 `jsonb`, 33 `timestamp`, 18 `bigint` (all `mode: "number"`),
4 `numeric`, 10 `pgEnum`.

### What round-trips correctly

Measured by inserting through the Drizzle handle and reading the row back.

| Column | Stored as | Read back | Verdict |
|---|---|---|---|
| `jsonb` | text | parsed object | correct — Drizzle stringifies on write and parses on read |
| `text` enum | text | string | correct |
| `bigint` `mode: "number"` | integer | number | correct inside `Number.MAX_SAFE_INTEGER` (2^53). Every bigint column uses `mode: "number"`, and none holds a value that large: token counters and epoch milliseconds both stay under it |
| `uuid` | text | string | correct |
| `boolean` | integer 0 or 1 | `true` or `false` | correct, since the column mapping in `db-sqlite.ts` |
| `timestamp` | ISO text | `Date` | correct, since the same mapping. A row holding epoch milliseconds, as a number or as its digits, reads back as that instant too |
| `numeric` | real | string | correct. Drizzle's numeric mapper stringifies the value, which is what the column declares. The scale is not stored: `numeric(12, 6)` is a bare type name to SQLite and the value keeps no trailing zeroes, so `"2.50"` reads back as `"2.5"`. The digits survive, including `"0.000001"` |
| `bytea` | blob | `Uint8Array` | the bytes survive, including a leading `0` and a `255`. The schema declares `Buffer` and bun:sqlite returns a `Uint8Array`, which is not a `Buffer`. Every current reader accepts both: `decryptCredential` branches on `Buffer.isBuffer`, and the popup image path takes a `Uint8Array`. A new reader that calls `Buffer.isBuffer` on a value it read will be wrong |

### What does not round-trip

Nothing measured on 2026-10-07 fails to round-trip. The `bytea` type difference
above is the one that will bite a future reader; it does not bite a current one.

### What is not a defect

Drizzle's insert builder omits a column the caller did not set, on both
backends. It never sends the JavaScript `.default()`, so a column declared
`.notNull().default(...)` fails the `NOT NULL` constraint when the insert
leaves it out. Measured on `tenants.status` and `telemetry_events.tenant_id`.
PostgreSQL behaves the same way through this builder, so it is not a parity
gap. The database-side `DEFAULT` clause only applies when the column is absent
from the statement entirely, which is the path the raw migration SQL uses.

### Already handled

`src/persistence/dialect.ts` branches the expressions that have no shared
spelling: `mergeJson`, `pruneExpiredCooldowns`, `caseInsensitiveLike`,
`laterOf`, `currentTimestamp`, `differsFrom`, and the first-boot
lock. `db-sqlite.ts` rewrites `gen_random_uuid()` and `now()` per statement,
converts `Date` bindings to ISO strings, maps boolean and timestamp
columns back to the types the schema declares (`installSqliteColumnMapping`),
skips no `ADD COLUMN` (SQLite has no `ADD COLUMN IF NOT EXISTS`; idempotency
comes from the migration ledger), and exposes `execute` (with rows) on both the
handle and the transaction. The generator rewrites the DDL types listed above
and drops `CREATE EXTENSION`, `CREATE TYPE`, `USING btree`, and `DESC`.

A caller that interpolates its own `::jsonb`, `::uuid`, or `octet_length`
bypasses `dialect.ts` and fails on SQLite. `usage-flush.ts` is the one *store*
that spells `::uuid` and `::bigint`, and it branches: PostgreSQL gets
`UPDATE ... FROM (VALUES ...)` with the casts, SQLite gets a
`SELECT ... UNION ALL` with neither, because SQLite stores the key as text and
rejects that `UPDATE ... FROM (VALUES ...)` form outright.
That branch is exercised by `test/persistence/usage-flush.test.ts`, which
flushes 25 keys in one statement on a migrated SQLite file and reads the
totals back.

### Measured and ruled out

Each of these was a suspected gap. All were measured on a migrated SQLite
file, and the tests in `test/persistence/sqlite-type-parity.test.ts` and
`test/console/sqlite-login-readback.test.ts` lock the ones that can regress.

- A boolean stored as `NULL` reads back as `null`, not as `0` or `false`. The
  mapping only rewrites `1` and `0`.
- A timestamp holding epoch milliseconds reads back as that instant. The
  column is `text`, so the number is stored as its digits, and `new Date`
  reads a digit string as a year and returns an invalid date. The mapping
  treats an all-digit string as milliseconds before the ISO conversion.
- `numeric` reads back as a string with its significant digits intact. The
  declaration `numeric(12, 6)` gives SQLite no affinity and no scale, which
  looks like a defect and is not one: the value is what the column promises,
  and only the trailing zeroes are lost.
- `usage-flush.ts` does not send `::uuid` or `::bigint` to SQLite. See above.
- The payload frame store is not a database column. `telemetry_payloads`
  holds a pointer; the body is a gzipped frame in a file, named `jsonl-file`,
  and a frame written before compression stays readable as `jsonb-file`.
- `db.execute` returns the same types the query builder returns. It used to
  read through `prepare().all()` and hand back stored values, so a timestamp
  came back as text and a boolean as `0` or `1` — the same mismatch that
  rejected a correct login, on the one read the backup import uses to decide
  whether a row already exists. It now maps each column through the same
  function the builder calls. A statement that reads one table is mapped; a
  `SELECT 1` or a join is returned as stored, because no single table owns
  its columns. The same change binds interpolated values: the alias used to
  join the SQL text and drop every parameter, so a statement with a `${}`
  value reached SQLite with a hole in it.

---

## Memory usage (RSS) and reporting leaks

What is normal, what is not, and what to do before you file anything.

### RSS grows, and mostly that is by design

- The JS runtime's allocator retains freed pages instead of returning them to
  the OS immediately: RSS climbs to a working-set ceiling and stays there.
  Cold-start RSS < steady-state RSS is the expected shape, not a leak.
- Every startup phase logs `rss_mb`/`heap_used_mb`, and periodic runtime
  metrics keep both coming (`CARTETHYIA_RUNTIME_METRICS_INTERVAL_MS`, default
  30 s). Diff them over time — that is the evidence that decides everything.
- Steady contributors: lazy module loading (per-provider integrations load on
  first dispatch), the quota cache (1,024 entries, 15-minute TTL), telemetry
  buffers, database pool sockets, and per-connection buffers.
- Read the two numbers separately: `rss_mb` climbing while `heap_used_mb`
  stays flat is allocator retention (normal). `heap_used_mb` climbing without
  bound as the same traffic repeats is retained objects — worth investigating.
- The gateway protects itself: when headroom runs low it sheds load with
  `overloaded` (503) instead of dying. `CARTETHYIA_MEMORY_LIMIT_BYTES` sets
  the ceiling; `CARTETHYIA_FORCED_GC` exists for diagnostics, not production
  tuning.

### Before you open a PR or issue about a memory leak

1. **Update first.** Re-test on the latest version of the branch you run —
   the leak you are seeing may already be fixed.
2. **Reproduce without your modifications.** Run the same workload on an
   unmodified checkout (or a published release):
   - Leaks on the **stock build** → it is ours: open the issue with the
     evidence below. A PR with the fix is even better.
   - Leaks **only with your modifications** — your added feature, your patch,
     your fork change — → the leak is in your code. Fix it on your side;
     do not file it upstream. An RSS climb that starts with the feature you
     added is the feature, not a leak.
3. Evidence that makes a report actionable: the `rss_mb`/`heap_used_mb`
   timeline over time, the exact version/commit, mode (lite/full), topology,
   provider mix, and a minimal reproduction.
