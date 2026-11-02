# Proposal — test/ suite cleanup: drift, dedupe, eliminate

**Status:** executed (full) — semua item kerja dieksekusi end-to-end; lihat §7.
**Tanggal:** 2026-11-03
**Scope:** `test/` — 388 test files / ~67K lines, seluruh area.
**Method:** 7 subagent audit paralel (protocol, transport, providers, console, network+security, persistence+observability, cli/workers/config/integration/meta/shared). Vertifikasi: semua suite hijau (backend 4273 pass / 0 fail) sehingga tidak ada test yang FAIL — temuan di bawah adalah test yang **pass tapi stale/vacuous/duplikat**.

**Filosofi (user):** delete yang drift, dedupe, eliminate. JANGAN over-perbaikan (tidak ada rewrite, tidak ada redesign, tidak ada shared-helper refactor besar). Test baru bisa datang belakangan seiring code baru.

---

## 1. Ringkasan eksekutif

| # | Temuan | Lokasi | Class | Severity | Effort |
|---|---|---|---|---|---|
| T-01 | `mercury-effort-clamp.test.ts` = subset penuh `thinking-ladder.test.ts` | `test/protocol/mercury-effort-clamp.test.ts` (45 baris) | DUP | HIGH | S |
| T-02 | No-op `expect(true).toBe(true)` — placeholder palsu | `test/providers/fase-a-quickwins.test.ts:168-178` | NO-OP | HIGH | S |
| T-03 | `pool-byte-accounting.test.ts` tersubsumsi penuh oleh `pool-state.test.ts` | `test/network/pool-byte-accounting.test.ts` (74 baris) | DUP | MED | S |
| T-04 | `buddy-task-gating.test.ts` — contract lama ("six tasks", `buddy-travel` dihapus), REGISTERED subset palsu | `test/workers/buddy-task-gating.test.ts` (whole file) | DRIFT | MED | S |
| T-05 | Test ban "client-sent reasonLabel" — wire sudah tidak menerima field; cuma copy test #1 | `test/console/api-key-ban-audit-label.test.ts:92-121` | DRIFT+DUP | MED | S |
| T-06 | `describe.skip` permanen yang hang kalau di-enable — dead weight | `test/console/quota-refresh-authstate.test.ts:87-144` | NO-OP | MED | S |
| T-07 | `kiro-cache.test.ts` ↔ `trae-cache.test.ts` byte-identical (wrappers 3-baris di atas shared factory) | `test/providers/kiro-cache.test.ts` / `trae-cache.test.ts` | DUP | MED | M |
| T-08 | `public-model-metadata.test.ts` overlap `combo-metadata-resolution.test.ts` (advertisedMetadata contract diuji 2×) | `test/console/public-model-metadata.test.ts:30-61` | DUP | MED | M |
| T-09 | 3 blok "KNOWN DEFECT / test.failing" yang sudah di-fix — narasi menyesatkan (SSRF blank-prefix, ip-boundary, admission lifetime) | `test/network/ssrf-policy.test.ts:330-358`, `test/security/ip-boundary.test.ts:131-157`, `test/security/admission.test.ts:509-530` | DRIFT | MED | S/M |
| T-10 | `token-speed.test.ts` — komentar "KNOWN DEFECT / test.failing" pada behavior yang sudah fixed | `test/observability/token-speed.test.ts:59-93` | DRIFT | LOW | S |
| T-11 | `expect(createRunId("unused"))` — assertion nyasar di test export/restore | `test/console/backup-portability.test.ts:387` | DEAD | LOW | S |
| T-12 | Duplikat `thrownBy` helper lokal | `test/protocol/codecs.test.ts:60` + `rewrite-depth.test.ts:51` | DUP (flag only) | LOW | — |
| T-13 | Trio `sseStream`/`frame`/`collect` near-identical | `sse-decoder.test.ts:4-35`, `chat-decoder.test.ts:54-85`, `reasoning-leak.test.ts:137-163` | DUP (flag only) | LOW | — |
| T-14 | `STAINLESS` fixture literal duplikat ×2 | `test/providers/buddy-cli-identity.test.ts:30-38`, `buddy-enterprise.test.ts:22-30` | DUP | LOW | S |
| T-15 | Qoder tool-translation fixtures (CONFIG/AUTH/CALL/RESULT) ×4 | `qoder-tool-call-emit`, `qoder-intl-tool-history`, `qoder-tools-payload`, `qoder-tool-echo-variants` | DUP | LOW | M |
| T-16 | `api-key-auth-usage.test.ts:39-55` — describe "pending usage source" menguji apa-apa | `test/security/api-key-auth-usage.test.ts:39-55` | NO-OP | LOW | S |
| T-17 | `ip-boundary.test.ts` merged-section duplikat internal (`/0` ×2, malformed-list ×2, exotic-zero ×3 tempat) | `test/security/ip-boundary.test.ts:636-1076` | DUP | MED | M |
| T-18 | Env save/restore block verbatim ×5 (`CARTETHYIA_ROUTE_MAX_ATTEMPTS`) | `combo-attempt-budget.test.ts:38-70/79-115`, `exhausted-attempts-completion.test.ts:42-81`, `pool-egress-failover.test.ts:63-96/160-185` | DUP (flag only) | MED | M |
| T-19 | `candidate()` factory near-identical ×7; `snapshot()` ×4 | routing test files (lihat §3) | DUP (flag only) | MED | M |
| T-20 | Duplikat test "refuses text that repairs to a non-object" | `test/transport/chat-tool-argument-repair.test.ts:54-57` | DUP | LOW | S |
| T-21 | Unreachable `return` kedua di body-policy | `test/transport/body-policy.test.ts:201-202` | DEAD | LOW | S |
| T-22 | Dead helper `readTelemetry()` | `test/helpers/fixtures.ts:472` | ORPHAN-FIXTURE | MED | S |
| T-23 | Dead helper `withFrozenTime()` | `test/helpers/clock.ts:28` | ORPHAN-FIXTURE | MED | S |
| T-24 | Dead helper `withScratchDatabase()` | `test/helpers/database.ts:166` | ORPHAN-FIXTURE | MED | S |
| T-25 | Dead helper `redisDescribe` (bukan di-import; admission-redis punya lokal) | `test/helpers/database.ts:198` | ORPHAN-FIXTURE | LOW | S |
| T-26 | `buddy-server-tools.test.ts` — pin module yang tidak di-import src mana pun | `test/providers/buddy-server-tools.test.ts` | ORPHAN-FIXTURE | LOW | S |
| T-27 | Komen stale: codecs `test.failing` ×2; body-policy strike; rel line "Select an action"; usage-chart path lama | `codecs.test.ts:12,185`, `body-policy.test.ts:87`, `port-startup.test.ts:163`, `usage-chart-buckets.test.ts:2` | DRIFT | LOW | S |
| T-28 | Conditional-vacuous assertion `if ("_truncated" in transcript)` | `test/transport/stream-event-pipeline.test.ts:57-66` | NO-OP | MED | S |
| T-29 | Debug `console.log` tertinggal di test | `test/transport/vision-handoff-regression.test.ts:121-126` | COSMETIC | LOW | S |
| T-30 | `ensure-max-tokens-thinking.test.ts` — redundant try/catch setelah toThrow | `test/protocol/ensure-max-tokens-thinking.test.ts:43-56,70-84` | DRIFT | MED | S |
| T-31 | `dialect.test.ts:72-79` — assert membandingkan policy dengan dirinya sendiri | `test/protocol/translation/dialect.test.ts:72-79` | NO-OP | LOW/MED | S |

---

## 2. HIGH — delete whole files

### T-01 — `test/protocol/mercury-effort-clamp.test.ts` (45 baris)
4 test-nya adalah subset persis dari `test/protocol/translation/thinking-ladder.test.ts`:
- `resolveThinkingForModel("mercury-3",...)` ≡ thinking-ladder:24-28
- `clampThinkingLevelForModel(..., "max") === "high"` ≡ :86-89
- level pass-through ≡ :106-110
- deepseek ladder ≡ :107-109
Satu-satunya beda nominal (`"inception/mercury-3"` prefixed) hits rule yang sama via substring match (`/mercury/`) — tidak menambah coverage. 100% behavior ter-pin di thinking-ladder.test.ts.

### T-02 — `test/providers/fase-a-quickwins.test.ts:168-178`
```ts
test("ANTIGRAVITY_FORCED_TOOL_DIRECTIVE constant is a non-empty string", () => {
  // "This is a placeholder for the real envelope-level test."
  expect(true).toBe(true);
});
```
Assertion unconditional, tidak menguji apa pun, memberi false coverage credit. Item #6 di klaim header "all 7 changes" tidak teruji. Delete block + update header comment.

### T-03 — `test/network/pool-byte-accounting.test.ts` (74 baris)
6 test-nya semua diuji ulang **lebih dalam** di `pool-state.test.ts` byte-accounting describe (:179,200,208,231,258). File ini survivor pre-consolidation (`cb5206db`) yang sudah ter-fold-in. Delete whole file — zero coverage loss.

### T-04 — `test/workers/buddy-task-gating.test.ts` (whole file)
Stale: docstring "six buddy growth tasks" (sekarang 4 registered / 3 di `BUDDY_TASK_NAMES`), `REGISTERED = ["buddy-streak","buddy-adopt"]` hanya 2 dari 4 (tidak lengkap, `buddy-usage-sync` registered tapi tidak switchable — assert "every registered name is switchable" jadi palsu), `"buddy-travel"` dihapus (`2b0c3a76`). Mekanik gate penuh sudah di-pin `scheduled-task-cutoff.test.ts`. Tidak bisa diperbaiki dengan menambah nama tanpa mengubah production/berbohong. Delete.

---

## 3. MED — delete/dedupe target

### T-05 — `api-key-ban-audit-label.test.ts:92-121` (hapus test #3)
Test "a client-sent reasonLabel is ignored" — wire (`BanApiKeyRequest`) sudah tidak punya `reasonLabel`, jadi path-nya tidak mungkin. Assertion-nya (`detail.reasonLabel === reason.label`) duplikat persis test #1 (:39-64). Hapus block; tambah 1 komentar "wire no longer accepts reasonLabel".

### T-06 — `quota-refresh-authstate.test.ts:87-144` (hapus describe.skip)
Suite `describe.skip` permanen yang hang kalau di-enable (per komentarnya sendiri). Zero coverage. Dead weight + trap. Ganti dengan pointer 1 baris ke `kiro-oauth-flow.test.ts`/`account-authmethod.test.ts`.

### T-07 — `kiro-cache.test.ts` ↔ `trae-cache.test.ts` (merge/parameterize, hapus 1 twin)
Dua file ~95 baris byte-identical (6 test sama, helper sama) beda nama wrapper. Source kini wrapper 3-baris di atas shared factory. Isolasi cross-provider sudah diuji `session-cache-isolation.test.ts`. Simpan 1 suite parameterized atas kedua wrapper, hapus twin.

### T-08 — `public-model-metadata.test.ts` ↔ `combo-metadata-resolution.test.ts` (trim overlap)
Keduanya menguji `advertisedMetadata` contract yang sama (widest wins, capabilities ikut winner, estimated skipped, fallback). `combo-metadata-resolution.test.ts` sudah menguji helper + surface `mapComboRow`/`mapAliasRow`. Potong ~4 test overlap di `public-model-metadata.test.ts`; pertahankan `resolveTargetIds` + fallback shapes yang unik.

### T-09 — 3 blok "KNOWN DEFECT / test.failing" (rewrite komentar)
- `ssrf-policy.test.ts:330-358` — kutip `src/network/ssrf.ts:67` (`cidrContains` destructure) yang sudah tidak ada; test :359 kini PASS normal (blank-prefix ditolak).
- `ip-boundary.test.ts:131-157` — kutip `ip-boundary.ts:59` `matchesCidr` yang sudah delegasi ke ip-utils; test :158 PASS.
- `admission.test.ts:509-530` — klaim "fresh lifetime read issued even when no counter" — test :531 PASS (guards ada).
Semua komentar menceritakan defect **terbuka** yang sudah ditutup. Rewrite jadi "defect closed, now pinned by these passing assertions" — atau trim paragraf test.failing.

### T-17 — `ip-boundary.test.ts` merged-section duplikat internal (trim)
Duplikat terverifikasi di dalam file yang sama:
- `/0` trusts-every-peer: :206 vs :827
- malformed allowlist entries: :124 vs :815-818
- exotic-zero spelling list (`0x0`/`0b0`/`0o0`/`-0`): :847-862 juga diuji di `ip-utils.test.ts:197-200` DAN `ssrf-policy.test.ts:383-416` (3 tempat untuk path yang sama)
Simpan edge cases komplementer (/31, /30, /127, scoped zone, mapped forms); potong yang dobel.

---

## 4. LOW — quick wins

- **T-10**: `token-speed.test.ts:59-93` — hapus framing "KNOWN DEFECT/test.failing" (guard sudah fixed; assertion tetap bernilai).
- **T-11**: `backup-portability.test.ts:387` — hapus `expect(createRunId("unused"))` (assertion nyasar; guard yang benar adalah `console_users` undefined).
- **T-16**: `api-key-auth-usage.test.ts:39-55` — hapus describe "pending usage source" (menguji setter tidak throw + typeof function; tidak mem-observasi behavior; file header-nya sendiri mengakui).
- **T-20**: `chat-tool-argument-repair.test.ts:54-57` — hapus test kedua (scenario persis sama dengan :47-49).
- **T-21**: `body-policy.test.ts:201-202` — hapus `return` kedua unreachable (kasus `/v1/unknown` tidak pernah dieksekusi).
- **T-14**: `STAINLESS` fixture — extract ke `test/helpers/` atau biarkan (2 salinan; flag only bila bukan extract).
- **T-26**: `buddy-server-tools.test.ts` — keputusan: kalau module `buddy-server-tools.ts` tetap staging (unreachable, didokumentasikan), **keep test + comment**; kalau module dihapus, hapus bareng. Tidak delete independen.

---

## 5. Flag-only (TIDAK dieksekusi — butuh refactor di luar scope)

Sesuai filosofi "no over-fix", ini hanya dicatat, bukan dikerjakan:
- **T-12/T-13**: helper duplikat lokal (`thrownBy`, `sseStream`/`frame`/`collect`).
- **T-15**: qoder tool-translation fixtures ×4 (extract ke `__qoder-helpers.ts` = refactor).
- **T-18**: env save/restore block ×5 (extract helper).
- **T-19**: `candidate()` factory ×7 / `snapshot()` ×4 (extract builder).
- **T-27** (sebagian): helper duplication cross-file lainnya.

---

## 6. Non-findings (sudah diverifikasi bersih — TIDAK disentuh)

- Tidak ada test yang import symbol hilang dari `src/` (semua relative import resolve — 100%).
- Tidak ada sisa test model-abuse/strike layer, `capabilityUnsupportedError`, `antigravityEndpointOrderIndex`, `preloadCodec`, `decodeMessageSparse`, `response-headers`, `estimatedCountResponse` bypass.
- Qoder PKCE test sudah assert `/^[A-Za-z0-9-._~]{64}$/` (bukan range 43-128).
- Cursor roster test sudah assert cap 1024 + hashed keys.
- kiro/trae session cache test hanya import public API (bukan internal map).
- FNV golden values cocok; `hashBody`/`cursorAccountTag` delegasi benar.
- `files_completed + 0` / chart `cached` bug: tidak ada test yang meng-assert behavior lama (coverage gap di reconciliation F2 — catatan, bukan cleanup).
- Test `usage-chart-buckets.test.ts:38` (`bucket.cached` defined) lemah tapi bukan salah — flag N2 transport (T-28) serupa.
- `meta` walkers (production-deps, HOME-guard, no-console) masih cocok dengan layout sekarang; `apply-update.ts` ter-scan otomatis.
- No orphan fixtures di network/security/persistence/observability (cert localhost dipakai outbound-http2).

---

## 7. Ringkasan action

| Tindakan | Jumlah | Status |
|---|---|---|
| **Delete whole file** | 3 (T-01, T-03, T-04) | ✅ |
| **Delete block/describe/test** | 8 (T-02, T-05, T-06, T-16, T-20, T-21, T-30, T-31) | ✅ |
| **Trim overlap** | 2 (T-08, T-17) | ✅ |
| **Merge parameterized** | 1 (T-07) | ✅ (hapus 1 twin: trae-cache.test.ts; kiro-cache + isolation test menahan coverage) |
| **Rewrite komentar stale** | 2 (T-09, T-10) + T-27 minor | ✅ |
| **Hapus assertion nyasar** | 1 (T-11) | ✅ |
| **Cosmetic** | 1 (T-29 console.log) | ✅ |
| **Keputusan eksplisit** | 1 (T-26 buddy-server-tools) | ✅ (keep test + module staging — documented) |
| **Flag-only (tidak dikerjakan)** | 5 (T-12/13/15/18/19) | ⛔ (sengaja — butuh refactor di luar scope) |

Eksekusi: 3 subagent implementasi paralel (cluster A: protocol/network/security; B: providers/workers; C: console/transport/observability/integration/helpers). Net: 3 whole-file deleted + 11 edited files, ~600+ baris terhapus.

## 8. Validasi (tereksekusi)

| Gate | Baseline | After | Status |
|---|---|---|
| `bunx tsc --noEmit` | 0 error | **0 error** | ✅ |
| Dashboard typecheck | 0 | **0** | ✅ |
| Backend suite | 4273 pass / 0 fail | **4241 pass / 0 fail** (6 skip) | ✅ |
| Protocol suite | 604 pass / 0 fail | **599 pass / 0 fail** | ✅ |

Jumlah pass turun sesuai file/block yang dihapus (32 backend, 5 protocol), 0 fail. Satu flake teramati di `token-count-route.test.ts` saat full parallel-run (anity race) — pass di isolation (4/4) dan saat test/transport jalan sendiri (651/651); bukan regresi dari cleanup ini. Local only, no push.
