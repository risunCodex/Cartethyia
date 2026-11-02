# Proposal — src/ cleanup Phase 2: leftover ⛔ findings (high-severity, logic-change allowed)

**Status:** awaiting approval
**Tanggal:** 2026-11-03
**Scope:** sisa temuan ⛔ dari `src-cleanup-proposal.md` (§7) yang dieksekusi parsial. Beda dengan Phase 1: temuan ini memang **butuh logic change** atau butuh desain — bukan dead-code removal biasa. Semua sudah di-audit ulang dengan baca penuh source + verifikasi call-site.
**Method:** 6 subagent audit paralel (network/security, protocol, transport, console, providers-core, integrations-B) + 1 verifikasi kecil (03/06 leftovers).

**Aturan eksekusi:** setiap item di-mark ✅/⛔ di proposal ini + di-referensikan di part md terkait; full suite (backend + protocol + tsc backend/dashboard) wajib hijau sebelum commit; **local only, no push**.

---

## 1. Ringkasan eksekutif

| # | Finding | Verdict audit | Behavior change? | Severity | Effort |
|---|---|---|---|---|---|
| P2-01 | **08 #22** `estimatedCountResponse` bypass telemetry | Fix: call finalizer inline, BUKAN `completeAttempt` | Telemetry-only (row/latency/console-log baru utk estimated count) | **HIGH** | S–M |
| P2-02 | **04 #22** `/updates/apply` fire-and-forget destructive | Redesign: detached installer + status file + graceful drain | Ya (destructive path) | **HIGH** | M |
| P2-03 | **12 #3** PKCE verifier pakai `Math.random` (qoder) | Fix: fixed length 64 + full CSPRNG | Security fix (RFC 7636) | **HIGH (security)** | S |
| P2-04 | **05 U1–U3** IP/IPv6/CIDR duplikat 3× | Shared `src/network/ip-utils.ts` dengan flag opt-in | No (dengan opt-in honored) | HIGH | M |
| P2-05 | **05 D1** `response-headers.ts` dead module | **Aman dihapus** (superseded by rebuild-from-scratch projection) | No | HIGH→low | S |
| P2-06 | **05 U4** Double DNS timeout wrapper | Drop outer timer; error class jadi deterministik 502 | Minor, favorable | Med | S |
| P2-07 | **08 #4** Dispatch handlers belum pakai native-shared | Migrasi generation/systemone/responses-compact | 1 wire change: generation JSON + `cache-control: no-store` | Med | M |
| P2-08 | **09 #4** `EligibilityEvaluator` structural cast | Shared `RoutedCandidate` type + narrow `quota_windows` | None (type-level); drop unproducible `"locked"` reason | Med | M |
| P2-09 | **12 #1** kiro/trae session-cache duplikat | Shared factory `createSessionCache()` (per-provider isolation preserved) | No | Med | S |
| P2-10 | **12 #2** `AWS_REGION_PATTERN` ×4 (kiro) | Single-source di `kiro-catalog.ts` | No | Low | S |
| P2-11 | **07 #5** `preloadCodec` unwired | **Delete** + fix docs (wiring kontraproduktif: +30–40 MiB RSS) | No | Low | S |
| P2-12 | **07 #23** `ensureMaxTokensForThinking` throw unreachable | Option A (drop throw) atau B (real ceiling at call site) | B = minor behavior change | Med | S/M |
| P2-13 | **07 #17** `toWellFormedString` double-cast fallback | Fallback unreachable di Bun ≥1.4 → langsung `value.toWellFormed()` | No | Low | S |
| P2-14 | **07 #24** `anthropicCacheControl` redundant branch | Collapse 3 return identis jadi 1 | No | Low | S |
| P2-15 | **11 #1** `antigravityEndpointOrderIndex` dead | Delete (satu-satunya referensi = definisinya) | No | Low | S |
| P2-16 | **11 #5** FNV-1a duplikat ×2 | Shared `fnv1a32` helper | No | Low | S |
| P2-17 | **11 #8** `rosterCache` unbounded | Cap 1024 + oldest-first eviction | No (memory leak fix) | Med | S |
| P2-18 | **10 #25** `resolveDialect` recompute per stream | Memoize di resolver.ts (mirror thinking-ladder) | No | Low | S |
| P2-19 | **10 #15** adapter `systemone` alias | **Keep + document** (public route, 2 live callers) — audit menolak removal | No | — | S |
| P2-20 | **09 #1** `capabilityUnsupportedError` dead | Delete | No | Low | S |
| P2-21 | **02 #23** `BackupExportResult` near-miss name | Rename jadi `BackupPayloadExport` (bukan konsolidasi) | No | Low | S |
| P2-22 | **02 #21** `reasonLabel` client-authored di audit trail | Derive server-side dari `reason` | Audit-integrity improvement | Med | S |
| P2-23 | **03 S2** Dead header writes di SSE route | Delete 4 baris `set.headers` (discarded oleh Elysia) | No | Low | S |
| P2-24 | **06 S2** Retention doc "15 minutes" vs 60 | Fix comment | Doc-only | Low | S |
| P2-25 | **11 #4** `decodeMessageSparse` | **Sudah hilang dari source** — stale entry saja | Doc-only | — | S |
| P2-26 | **05 O1** ValidatedFetch closure cache | **Close as done** (`pooledFetchCache` WeakMap sudah ada) | — | — | — |
| P2-27 | **06 U4** flush-buffer "duplication" | **Close: not-worth-it** (idiom ~15 baris, bukan skeleton; konsolidasi malah coupling) | — | — | — |
| P2-28 | **03 O4** UA client-name cache | **Close: skip** (nanosecond-cost, off hot path) | — | — | — |

Total: 24 item kerja + 3 close-without-action + 1 keep-and-document. Estimasi gabungan: **~1.5–2 hari**.

---

## 2. Item HIGH severity — detail

### P2-01 — `estimatedCountResponse` bypass telemetry (08 #22)

**Lokasi:** `src/transport/dispatch/token-count.ts:96, 209-218` — route `POST /v1/messages/count_tokens`, trigger: `capability_unsupported` dari preparer (model chat-family tanpa endpoint count_tokens).

**Yang skip saat ini (diverifikasi trace ke `finalizeRequestTelemetry`, guards/error-lifecycle.ts:184):**
1. `proxy_request_latency_ms` tidak pernah di-observe untuk estimated count → histogram blind spot permanen.
2. Console Log event `request_complete` tidak pernah di-push → request sukses tidak muncul sama sekali.
3. Durable telemetry row **tidak pernah ditulis** — padahal route eligible (`TOKEN_COUNT_PATH` ada di `isProxyDispatchRoute`, tenantId tersedia).
4. `notifyRequestCompleted` skip.
5. Fallback `afterResponse` juga mati karena `state.completed = true` di-set manual → request di-finalize **nowhere**.

**Kenapa BUKAN lewat `completeAttempt`:** tidak ada lease, tidak ada provider yang melayani angka; `completeAttempt` akan invent health/usage bookkeeping. Doc function-nya sendiri melarang. Fix yang benar = panggil `finalizeRequestTelemetry` langsung (pola yang sama dengan early-rejection fallback).

**Perubahan:**
```ts
function estimatedCountResponse(state, countBody, telemetryBuffer, db): Response {
  const inputTokens = estimateMessagesInputTokens(countBody);
  const payload = JSON.stringify({ input_tokens: inputTokens });
  state.outcome = {
    status: "completed", httpStatus: 200,
    usage: estimatedUsage(inputTokens, 0),   // unpriced: estimated_cost: null
  };
  state.completed = true;                     // mencegah afterResponse fallback double-finalize
  state.clientResponseText = payload;
  metrics.proxy_requests_total.inc(1, { status: "completed" });
  if (telemetryBuffer) finalizeRequestTelemetry(state, telemetryBuffer, db);
  return new Response(payload, { headers unchanged });
}
```
- `payloadCaptureState` **tidak dipalsukan** — dibiarkan unset (pola early-rejection).
- Idempotency: finalizer bukan idempotent → dipanggil tepat 1× (dijamin oleh `completed = true`).
- Client response: byte-identical (200, body, headers tak berubah).

**Test:** extend `test/transport/token-count-route.test.ts` — assert telemetry row tertulis (status completed, endpoint `/v1/messages/count_tokens`, usage estimated, `estimated_cost === null`), latency observed tepat 1×, console log `request_complete` masuk, dan tidak ada double-row.

### P2-02 — `/updates/apply` redesign (04 #22)

**Lokasi:** `src/console/updates/routes.ts:105-119`. Saat ini: spawn detached shell `npm install -g cartethyia@latest --prefer-online && (systemctl restart || carte start)`, `stdio: "ignore"`, lalu `setTimeout(() => process.exit(0), 1500)` — **hard exit yang bypass `ShutdownCoordinator`**, tanpa exit-code check, tanpa drain, `{ started: true }` selalu.

**Masalah terverifikasi:**
1. `npm install` gagal (EBUSY Windows — failure mode terdokumentasi di `scripts/cli/update.ts:1-10`, network down, package 404) → gateway **mati** dengan versi lama, tidak ada restart, tidak ada laporan.
2. `process.exit(0)` di t+1.5s memotong in-flight LLM stream, skip flushTelemetry/closePools — persis yang `ShutdownCoordinator.begin("update")` (lifecycle.ts:86-128) dirancang untuk cegah; `SIGUSR2`→`shutdown("update")` sudah terdaftar di main.ts:195 tapi route ini tidak memakainya.
3. Tidak memanggil `stopHoldingProcesses()` (taskkill Windows) yang CLI update (`scripts/cli/update.ts:25-38`) sudah punya — console route drift dari CLI.
4. Dashboard (`dashboard/src/apps/console/shell.tsx:698-719`) poll release tag selamanya jika install gagal.

**Desain (detached installer + status file + graceful drain)** — supervisor proses tidak ada di deployment model (global npm CLI, systemd/tray), dan installer HARUS outlive proses ini (EBUSY), jadi opsi "managed child" mustahil:

1. Extract shared module `src/console/updates/apply-update.ts` — single source of truth untuk console route + CLI update (menghentikan drift, termasuk `stopHoldingProcesses`).
2. **Status file** di config dir: tulis `{status:"installing", targetTag, startedAt}` sebelum spawn; detached wrapper (via `node -e` atau shell) menimpa dengan `{status:"success"|"failed", exitCode, stderrTail}`; `stdio` → log fd ke `update.log` rotating.
3. **Graceful drain**: ganti `setTimeout(process.exit)` dengan `await shutdownCoordinator.begin("update")` + safety timer `totalShutdownBudgetMs()` (in-flight dapat shutdown notice "update" via shutdown-notice.ts), lalu `process.exit(0)`.
4. **`GET /updates/status`** baru (read-only, posture no-scope sama seperti `/updates/release`); dashboard poll beralih: failed → render error + log tail + stop; success → verify version + reload.
5. **Double-apply guard**: status `installing` umur <10 menit → 409.

**Test:** status file round-trip; failing `npm` shim → status failed + exitCode; installing guard 409; route factory mock coordinator (`begin("update")` dipanggil sebelum exit); integrasi: stream panjang selesai sebelum exit; dashboard poll states.

### P2-03 — PKCE verifier `Math.random` (12 #3) — SECURITY

**Lokasi:** `src/providers/integrations/qoder/qoder-oauth.ts:235` — `const length = 43 + Math.floor(Math.random() * 86)`.

**Analisis:** konten verifier sudah CSPRNG (`randomBytes`, :236) — hanya **length** yang non-crypto. RFC 7636 §4.1 mewajibkan CSPRNG untuk verifier; predictable length mengecilkan entropy space secret device-flow. Plus: `Math.random` di path credential-adjacent adalah standing audit failure. Tidak ada `Math.random` lain di oauth paths (grep clean).

**Fix:**
```ts
const length = 64; // RFC 7636 §4.1 [43,128]; fixed; content via randomBytes (CSPRNG)
```
- Alphabet `A-Za-z0-9-._~` **dipertahankan** — doc comment (:224-231) menjelaskan fidelity terhadap desktop IDE alphabet itu load-bearing; jangan swap ke `generatePkcePair()` (base64url, alphabet beda).
- Modulo bias 67∤256 ≈ 21/256 per char: negligible utk 64-char secret dengan ~388 bit input entropy; cukup dicatat di comment.

**Test:** qoder-oauth suite; assert semua verifier `/^[A-Za-z0-9._~-]{64}$/`; grep gate `Math.random` → 0; satu device-flow login manual utk confirm upstream terima fixed-64.

---

## 3. Item MEDIUM — detail ringkas

### P2-04 — Shared `src/network/ip-utils.ts` (05 U1–U3)

**Duplikat terverifikasi:**
- IPv4: `ipv4Number` (ssrf.ts:34-41, throws) vs `ipv4ToNumber` (ip-boundary.ts:7-15, returns undefined) — numerically equivalent, hanya beda error channel.
- IPv6: `ipv6Bytes` (ssrf.ts:43-70) vs `ipv6ToBigInt`+`normalizeIpv6Groups` (ip-boundary.ts:17-33, 100-147). **Subtle:** ssrf menerima dotted-quad compatible form (`::1.2.3.4`), ip-boundary deliberately fail-closed (pinned oleh test:1063). Konsolidasi tanpa opt-in akan **mengubah DB uniqueness key** (`canonicalClientIpKey`) → inilah kenapa severity high.
- CIDR: `cidrContains` (ssrf.ts:72-109, bare address → false, no mapped-unwrap) vs `matchesCidr` (ip-boundary.ts:149-185, bare → exact-host, mapped-unwrap). Beda **on purpose**.
- Bonus: 3 loopback predicate berbeda — `isLoopbackPeer` (drain-endpoint.ts:37-43) **paling lemah** (miss mapped spellings `0:0:0:0:0:ffff:7f00:1`) dan dipakai untuk gate admin (drain/reset/export).

**Desain:** satu file `src/network/ip-utils.ts` dengan:
- `ipv4ToNumber` / `ipv4ToNumberStrict`
- `normalizeIpv6Groups(addr, { allowDottedQuad?: boolean })` + `ipv6GroupsToBytes` / `ipv6GroupsToBigInt` — ssrf pakai `allowDottedQuad: true`, ip-boundary default (refuse) → **semantik per-modul preserved**.
- `cidrContainsAddress(addr, cidr, { requirePrefix, unwrapMapped })` — ssrf: `{true, false}`, boundary: `{false, true}`.
- `isLoopbackAddress` (structural, semua mapped spelling + `::1`).
- `isLoopbackPeer` di drain-endpoint di-unify → **behavior-widening** (admin gate menerima mapped loopback spelling — strictly more correct). **Rekomendasi: land sebagai commit terpisah dengan test sendiri**, atau defer dengan comment.

**Test:** suite existing (ssrf-policy, ip-boundary mapped regression 989-1074) adalah safety net; tambah parity table test `test/network/ip-utils.test.ts` (~40 spellings, golden values).

### P2-07 — Migrasi native-shared (08 #4)

**Inventory terverifikasi** (✅ = sudah migrate):

| Handler | requireRecordBody | hasScope | resolveAttemptCredential | stripThinkingSuffix | networkFetchContext | jsonResponse |
|---|---|---|---|---|---|---|
| token-count | ✅ | ✅ | ✅ | n/a | ✅ | n/a (verbatim upstream body) |
| websearch | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| generation | ❌ :162-168 | ❌ :173 | ❌ :224-236 | n/a | ❌ :312-319 | ❌ :77-82 **drift: tanpa cache-control** |
| systemone | ❌ :35-36 | n/a | ❌ :88-100 | ❌ :45-47 | ❌ :134-141 | n/a (verbatim) |
| responses-compact | ❌ :29-30 | n/a | ❌ :91-98 | ❌ :42-44 | ❌ :113-120 | n/a (verbatim) |

- **Satu wire change nyata:** `generation.ts:77-82` jsonResponse drift — JSON responses image/video/embedding/audio akan dapat `cache-control: no-store` (correctness improvement, per-request responses memang tidak cacheable). Test header assertion perlu update.
- `usageFromUpstreamClone` juga tersedia untuk systemone (:157-173) & responses-compact (:129-139) — inline copies equivalent.
- Verbatim-upstream Response builders **bukan** duplikat jsonResponse — dibiarkan.

### P2-08 — `RoutedCandidate` typed fix (09 #4)

- Cast di `router.ts:340-353`: sebagian field sudah ada di `RouteCandidate` (usage_floor*, quota_windows, cooldown_kind), sisanya stamp dari route-catalog (yang punya local type identik di :87-97).
- `account_locked`/`locked`: **no producer di src maupun test** → dead; branch `reason: "locked"` unproducible, dihapus.
- `lane?: "slow"`: test-supported saja (runtime slow-lane dibaca via `sharedClaudeSlowLanes.isActive`), dipertahankan di type dengan doc.
- `quota_windows` di-narrow dari `readonly unknown[]` → `readonly ProviderQuotaWindow[]` (verify no import cycle: aman, quota contracts tidak import route-model) → casts di router.ts:97-102, 130-133 hilang.
- route-catalog drop local `RouteCandidateWithHealth`, import shared type.

### P2-09 — Shared session-cache factory (12 #1)

`kiro-cache.ts` dan `trae-cache.ts` (masing2 ~111 baris) **byte-identical modulo identifier**. Bahaya konsolidasi: merge map = cross-contamination antar provider. Desain: **factory** `createSessionCache()` di `src/providers/integrations/shared/session-cache.ts` (dir sudah ada) — tiap integration punya private map sendiri via factory, logic single-sourced. Call sites & tests unchanged; tambah 1 test cross-provider isolation.

### P2-12 — `ensureMaxTokensForThinking` throw (07 #23)

Throw unreachable terverifikasi: kedua call site (messages.ts:678, :714) pass `Number.MAX_SAFE_INTEGER`; budget di-clamp ≤128k di parse time. **Tapi audit menemukan latent bug adjacent:** dengan ceiling unbounded, OAuth request budget 100k dapat `max_tokens = 101_024` — **di atas OAuth ceiling 64k** yang baru saja di-enforce `resolveWireMaxTokens` → upstream 400 opaque alih2 clean clamp.

- **Option A (minimal):** drop throw, keep clamp, dokumentasi realitas.
- **Option B (recommended):** pass real ceiling (`WIRE_TOKEN_BOUNDS.messages.oauthCeiling` untuk OAuth) → impossible OAuth request jadi typed 400 lokal. Minor behavior change: beberapa request yang sebelumnya "sukses lalu upstream-400" jadi lokal 400 bersih.
- **Jangan** ganti throw dengan silent-clamp-to-maxAllowed: `budget ≥ max_tokens` di-reject Anthropic (`budget_tokens` harus < `max_tokens`).

**Rekomendasi: Option B** + unit test baru `test/protocol/ensure-max-tokens-thinking.test.ts`.

### P2-17 — `rosterCache` unbounded (11 #8)

`cursor.ts:85` — module-level Map, keyed **raw credential string**, TTL check on-read only → expired entry tidak pernah dihapus; token rotation = growth superlinear. Fix: cap 1024 + oldest-first eviction (pola yang sama dengan sibling caches: `lastGoodEndpoints` antigravity, install-id). Optional follow-up: key via `fnv1a32(credential)` (pairing natural dengan P2-16).

---

## 4. Item LOW / S — ringkas

- **P2-05** Delete `src/network/response-headers.ts` (39 lines) + test-nya (93 lines). Superseded: `proxySuccessHeaders` (dispatch/upstream.ts:29-35) rebuild header set from scratch — upstream headers tidak pernah di-forward wholesale, jadi denylist tidak reachable. Tambah 1 comment di outbound-headers.ts yang menyimpan invariant knowledge + pointer ke git history.
- **P2-06** Drop outer DNS timeout di `pool/agent.ts:125-126,149` (inner `resolveAllAddresses` sudah race 5s timer + signal). Error class jadi deterministik 502 `transport_unavailable` (sebelumnya race-dependent 502 vs 499/504). Favorable.
- **P2-11** Delete `preloadCodec` (registry.ts:152-159) + fix 2 doc comment yang berbohong (menyebut `preloadCodecs()` yang bahkan tidak ada). **Wiring ditolak:** preload 3 codec = +30–40 MiB resident permanen — kontra desain lazy import itu sendiri; tidak ada family yang knowable at boot. Rewrite coverage test ke `encodeWireRequest`.
- **P2-13** `toWellFormedString` → `return value.toWellFormed()` (ES2024, dijamin Bun ≥1.4 = satu2nya runtime; fallback unreachable, tests sudah pin native behavior).
- **P2-14** `anthropicCacheControl` — 3 return byte-identical; collapse jadi 1 (keep param `_hint` untuk call-site intent); narrow return type; tambah unit test kecil.
- **P2-15** Delete `antigravityEndpointOrderIndex` (+`DEFAULT_ORDER_INDEX` jika hanya dipakai di sana) — confirmed dead.
- **P2-16** Shared `fnv1a32` (2 duplikat: claude fallback-credit.ts:127-134, cursor-quota.ts:228-235, keduanya FNV-1a 32-bit equivalen); formatting tetap di call site. Golden test (`""` → `0x811c9dc5`).
- **P2-18** Memoize `resolveDialect` di resolver.ts — key `${modelId}|${providerId}|${wireFamily}|${override}|${declared}` (semua value types → collision-safe); pattern mirror `THINKING_RESOLVE_CACHE`. Recompute di compatible-adapter.ts:394 jadi Map hit; no signature change.
- **P2-19** `systemone` alias — **audit menolak removal**: `/v1/systemone` adalah public documented API (README.md:108, errors.md:106) dengan 2 live callers (boot/app.ts:576, probing-service.ts:332-339) dan bukan legacy shim. Action: strengthen comments saja (provider-contracts.ts:293 + compatible-adapter.ts:336) supaya liveness verifiable via grep.
- **P2-20** Delete `capabilityUnsupportedError` (route-model.ts:400-407) — zero callers; string `"capability_unsupported"` hidup dan tetap.
- **P2-21** Rename `BackupExportResult` → `BackupPayloadExport` (contracts.ts:501) — bukan duplikat sesungguhnya, tapi near-miss dengan `BackupExportFileResult` (export-endpoint.ts:41); konsolidasi ditolak (module concerns beda).
- **P2-22** `reasonLabel` — bukan duplikasi, tapi **audit-integrity**: backend menyimpan free-text client-authored di audit trail yang fully derivable server-side dari `reason` via `API_KEY_BAN_REASONS`. Fix: derive server-side, drop field dari wire contract + dashboard mutation. Unknown/custom reason → tanpa label (free-text `reason` tetap terekam).
- **P2-23** Delete 4 baris `set.headers` di console/observability/live.ts:97-100 — discarded (handler return `Response`, header set-nya milik `consoleSseResponse`). Doc comment 1 baris.
- **P2-24** Fix stale comment payload-capture.ts:415 "15 minutes" → "an hour" (konstanta `DEFAULT_PAYLOAD_RETENTION_MS` = 60 menit; line 16 sudah benar).

---

## 5. Close without action (terverifikasi)

- **P2-25** (11 #4) `decodeMessageSparse` — **sudah tidak ada di source** (file berakhir di `decodeMessage`, :2276). Stale entry di proposal saja; part 11 md akan dikoreksi.
- **P2-26** (05 O1) ValidatedFetch closure cache — **sudah implemented**: `pooledFetchCache = WeakMap<PoolAgent, ValidatedFetch>` (resolver.ts:960, :993-997). Residual = 1 arrow function per request — not worth it. Close.
- **P2-27** (06 U4) flush-buffer "duplication" — kedua buffer structurally different (telemetry-buffer = timer+backoff+retry; payload-store = 10-line drain flag untuk worker serialization). Unify = coupling availability path ke drain gates. **Not worth it.**
- **P2-28** (03 O4) UA client-name cache — ~5 string ops, off hot path (telemetry buffered async). Skip.

---

## 6. Urutan eksekusi & validasi

1. **Security first:** P2-03 (PKCE).
2. **HIGH telemetry/destructive:** P2-01, P2-02.
3. **Shared foundations:** P2-04 (ip-utils) → P2-16 (fnv1a32) → P2-09 (session-cache) → P2-10.
4. **Type-level & protocol:** P2-08, P2-11, P2-12, P2-13, P2-14, P2-18.
5. **Dead code & dedupe:** P2-05, P2-06, P2-15, P2-20, P2-21, P2-23, P2-24.
6. **Migration dispatch:** P2-07.
7. **Docs/keep:** P2-19, P2-25–28 (bookkeeping).
8. P2-17 (rosterCache cap) — bisa kapan saja.

Per-batch: `bunx tsc --noEmit` (backend + dashboard) + `bun run test:backend` + `bun test test/protocol` wajib hijau; P2-04 & P2-02 land sebagai commit terpisah (behavior-widening / destructive-path). Marker ✅/⛔ di-update di proposal ini + part md terkait (05, 07, 08, 09, 10, 11, 12, 02, 03, 06, 04).

**Estimasi total: ~1.5–2 hari kerja. Semua local, tanpa push.**
