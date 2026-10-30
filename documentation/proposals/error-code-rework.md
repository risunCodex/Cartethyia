# Proposal: Error code rework — overlap, ID di envelope, dan bahasa pesan

Status: **implemented** (Fase 1 + 2 + 3 selesai; sapuan pesan seluruh call site).
Referensi final: `documentation/reference/errors.md`.

---

## 0. Ringkasan

Tiga masalah yang diperbaiki:

1. **Overlap code** — beberapa code memikul makna ganda atau keluarga code
   yang bertumpuk (`invalid_request` dipakai dengan 7 status berbeda;
   `shutting_down` ≈ `restart_for_update`; `authentication_failed` vs
   `invalid_request` 401 untuk kondisi auth yang sama; lima code "capacity").
2. **ID tidak sampai ke client** — header `x-request-id` selalu dikirim,
   tapi body error **tidak pernah** membawa `requestId`, dan id domain
   (`accountId`, `poolId`, `providerId`, `model`, `link`) hanya diisi sebagian
   kecil error. Client tidak bisa correlate error dengan log.
3. **Bahasa pesan** — pesan sekarang formal/kaku dan panjang. Diusulkan
   **tetap formal di awal** (jelas, actionable), **setiap lead menyebut
   `requestId` di dalam teksnya**, dan **setiap pesan diakhiri satu baris
   hangat** yang ringan — variasi emoji, tidak melulu satu jenis.

---

## 1. Overlap — analisis dan koreksi

### 1.1 `invalid_request` — overloaded parah

Saat ini `invalid_request` dipakai dengan **7 status berbeda** untuk makna
yang tidak sama:

| Status | Makna saat ini | Seharusnya |
| --- | --- | --- |
| 400 | Payload rusak/body invalid/param salah | `invalid_request` (tetap) |
| 401 | "Request carries no usable credential" (api-key-auth) | **`authentication_failed`** (401) |
| 403 | Loopback-only endpoint (drain/reset/export), CSRF gagal, routing scope | **`policy_rejected`** (403) |
| 404 | `no such task` (boot) | **`not_found`** (404) |
| 409 | Duplicate task, tenant belum setup | `invalid_request` (tetap) atau `upstream_conflict`-style |
| 413 | Body terlalu besar (`bodyTooLargeError`) | **`request_too_large`** (413) |
| 422 | Validation Elysia (console) | `invalid_request` (tetap) |
| 500 | Write gagal (export-endpoint) | **`internal_error`** (500) |

**Koreksi:** `invalid_request` hanya untuk 400/422 (payload/semantik
request). Kasus auth → `authentication_failed`, kebijakan → `policy_rejected`,
tidak ketemu → `not_found`, kebesaran → `request_too_large`, kegagalan server
→ `internal_error`.

### 1.2 `authentication_failed` vs `invalid_request` 401

`api-key-auth.ts` melempar `invalid_request` 401 untuk "no usable credential";
`unknownApiKeyError` menggunakan `authentication_failed` 401. Dua penyebab
auth yang hampir sama (tidak ada credential vs credential salah) terpecah ke
dua code. **Koreksi:** keduanya `authentication_failed`; detail di
`details.reason` (`"missing_credential"` vs `"invalid_key"`).

### 1.3 `shutting_down` vs `restart_for_update`

Dua-duanya drain 503; bedanya hanya alasan. Dua code untuk satu perilaku
client (retry nanti). **Koreksi:** gabung jadi `shutting_down`, dengan
`details.reason = "restart_for_update" | "graceful"`. `restart_for_update`
dihapus dari union atau dipertahankan sebagai alias yang di-map di
middleware (lihat §3).

### 1.4 Keluarga "capacity" — 5 code

| Code | Status | Makna |
| --- | --- | --- |
| `capacity_exhausted` | 429/529 | concurrency key (admission) ATAU upstream overload |
| `provider_capacity_exhausted` | 429 | max-inflight akun provider |
| `tenant_capacity_exhausted` | 429 | concurrency tenant |
| `proxy_pool_capacity_exceeded` | 429 | pool di limit concurrency |
| `proxy_pool_provider_capacity_exceeded` | 429 | pool kena limit per-proxy provider |

Pemisahan ini **benar** dan memang disengaja (komentar di `route-model.ts`),
tapi `capacity_exhausted` masih memikul dua makna berbeda (key vs upstream).
**Koreksi:** `capacity_exhausted` dibatasi jadi **key concurrency** saja
(429); upstream overload → code baru **`upstream_overloaded`** (529).
(`overloaded` gateway-headroom tetap terpisah.)

### 1.5 `platform_unavailable` — makna ganda

`platform_unavailable` dipakai untuk: upstream 5xx, deploy gagal
(Cloudflare/Vercel/Deno), kill-switch invoke, readiness dependencies. Ini
dua dunia: upstream vs gateway-own.
**Koreksi:** upstream 5xx → tetap `platform_unavailable` (origin `upstream`);
kill-switch/readiness (gateway-own, 503) → `platform_unavailable` tetap
TAPI dengan `details.reason` wajib (`"invoke_switched_off"`,
`"dependencies_not_ready"`), dan origin `cartethyia` membedakannya.

### 1.6 `policy_rejected` vs `client_router_denied`

Keduanya 403 kebijakan. `client_router_denied` khusus denylist client-router —
tetap kode terpisah (spesifik, biar operator tahu persis). Tidak digabung.

### 1.7 Keluarga "unavailable" — `transport_unavailable` / `proxy_pool_unavailable` / `proxy_pool_unhealthy` / `overloaded` / `shutting_down`

Sudah terbedakan oleh origin (`network` vs `cartethyia`) dan makna. Tidak
perlu digabung; yang perlu adalah `details.reason` wajib di semua (lihat §2).

---

## 2. Proposal envelope — ID sampai ke client

### 2.1 Aturan baru

1. **`requestId` WAJIB di setiap body error `/v1/*`**, dalam **dua tempat**
   sekaligus:
   - **Struktur:** field `error.requestId` (metadata panggilan) — diisi
     middleware dari `state.requestId`.
   - **Teks pesan:** lead message WAJIB menyebut `(request {requestId})` —
     supaya client yang cuma membaca string (log, parsing sederhana) tetap
     bisa correlate ke server.
2. **Id domain wajib di `details`** bila relevan dengan code:
   - `accountId` — error nyangkut akun (auth, capacity provider, policy, quota)
   - `poolId` — semua code `proxy_pool_*`
   - `providerId` — error provider / upstream
   - `model` — semua code model/routing
   - `link` / `slug` — share link
   - `upstreamRequestId` — bila ada dari upstream (sudah ada)
3. **Sumber implementasi:** `createErrorNormalizationMiddleware`
   (`error-lifecycle.ts`) sudah punya `state.requestId` — tinggal tambah
   dua baris: `requestId: state?.requestId ?? crypto.randomUUID()` di
   envelope, dan pastikan lead message memuatnya (dipasok pembuat error).

### 2.2 Bentuk envelope baru (transport)

```json
{
  "error": {
    "origin": "upstream",
    "code": "quota_exceeded",
    "requestId": "7f3c…ab12",
    "message": "This key has used its requests-per-minute allowance (request 7f3c…ab12). Wait for the window to roll over, or raise the key's rpm limit. You've maxed this window — pace yourself ⏳",
    "details": {
      "accountId": "459a66b6-…",
      "providerCode": "110",
      "providerStatus": 403
    }
  }
}
```

Tidak ada field yang dihapus — murni additive. Client lama tetap bisa parse.

---

## 3. Perubahan union `GatewayErrorCode` (ringkas)

| Aksi | Code |
| --- | --- |
| Tetap | seluruh 51 code kecuali yang di bawah |
| Dihapus | `restart_for_update` (digabung → `shutting_down` + reason) |
| Ditambah | `upstream_overloaded` (529, upstream overload) |
| Dibatasi makna | `invalid_request` (hanya 400/422), `capacity_exhausted` (hanya key concurrency 429), `authentication_failed` (termasuk missing credential), `not_found` (termasuk task tidak ada) |
| Alias | `restart_for_update` tetap di-parse oleh middleware → `shutting_down` + reason |

---

## 4. Bahasa pesan — tone & contoh

### 4.1 Aturan tone (dipakai broad)

1. **Lead = formal, selalu, dan menyebut requestId.** Struktur lead:
   `apa yang terjadi + (request {requestId}) + aksi`. RequestId HARUS ada di
   dalam teks, bukan hanya di field struktur.
2. **Tail = hangat, selalu ada, 1 kalimat di akhir.** Variasi emoji per
   code (tidak melulu sama); ringan, tidak mengejek, tidak menyalahkan
   user secara sinis.
3. **Dua gaya tail:**
   - **Soft-cool** (untuk error yang butuh perhatian serius: auth, policy,
     invalid request, link, internal): hangat dan stylist.
   - **Playful** (untuk kondisi transien sisi-server: capacity, pool,
     5xx, deadline, drain): lebih lucu, emoji santai.
4. **Emoji:** maksimal 1 per pesan, netral dan hangat (`🥰`, `💛`, `☕️`,
   `🌸`, `🦋`, `✨`, `🌙`, `🐻`, `🧘`, `📚`, `🔑`, `🗺️`, `🐢`, `👻`,
   dst). Tidak dipakai emoji yang mengejek atau terlalu mencolok untuk
   error yang membuat frustrasi.
5. **Konsisten:** karena pesan dipakai luas (SDK, LLM client, dashboard,
   CLI), tail harus selalu pendek (±1 kalimat), tidak multitafsir, dan
   tidak bertumpuk (maks 1 tail + 1 emoji).

### 4.2 Gaya tail

| Gaya | Kapan | Isi |
| --- | --- | --- |
| **Soft-cool** | error permanen / sensitif / butuh aksi serius | Lead formal + requestId + 1 tail hangat (tanpa ejek). |
| **Playful** | transien sisi-server (retryable) | Lead formal + requestId + 1 tail lucu + emoji santai. |

### 4.3 Template

```
<Lead: formal + (request {requestId}) + aksi> <Tail: 1 baris hangat (soft-cool / playful)>
```

### 4.4 Rasa (3 contoh singkat)

**Playful — `provider_capacity_exhausted`**
> Every account is at its concurrency limit (request 7f3c…ab12). Retry shortly; if it persists, raise the provider's max-inflight or add an account. Even the machine needs a rest — chill 🦋

**Playful — `overloaded`**
> The gateway is at capacity (request 7f3c…ab12); retry shortly. It's not you, it's us — come back in a few minutes ☕️

**Soft-cool — `authentication_failed`**
> Invalid API key (request 7f3c…ab12). Check the key you are sending, or create a new one in API Keys and send it as: Authorization: Bearer <key>. Wrong key, right door — double-check and come back 🔑

---

### 4.5 Tabel lengkap — semua code (apply for all)

Kolom: **Gaya** | **Pesan sekarang** (representatif dari source) | **Pesan usulan**.

Telmetry/boot-only code ditandai — tidak sampai ke client, pesan tidak berubah.

| Code | Gaya | Pesan sekarang | Pesan usulan |
| --- | --- | --- | --- |
| `capability_unsupported` | Soft-cool | "No account serving this model supports X. Drop the X part of the request, or route to a model that accepts it." | "No account serving this model supports {capability} (request {requestId}). Drop the {capability} part of the request, or route to a model that accepts it. Know your tools — this one just isn't in the box 🧰" |
| `ambiguous_model` | Soft-cool | "'x' matches more than one provider (a, b). Qualify it as 'a/x', or add an alias to pick one." | "'{model}' matches more than one provider ({owners}) (request {requestId}). Qualify it as '{owner}/{model}', or add an alias to pick one. Too popular for its own good — qualify it 🧩" |
| `model_not_found` | Soft-cool | "'x' is not routed — it resolved to 'y', which no account serves. Enable the model on an account, or point the alias at one that exists." | "'{model}' is not routed — it resolved to '{target}', which no account serves (request {requestId}). Enable the model on an account, or point the alias at one that exists. Try another model — this one's off the menu 📚" |
| `upstream_not_found` | Soft-cool | "Provider returned HTTP 404." (pesan upstream passthrough) | "The upstream could not find this resource (HTTP 404, request {requestId}): {message}. The path you seek is on another server 🗺️" |
| `context_length_exceeded` | Soft-cool | (pesan upstream passthrough) | "The prompt exceeds the model's context window: {used} tokens > {maximum} (request {requestId}). Compact the prompt or split the request. Great essay, wrong window 🤭" |
| `request_too_large` | Soft-cool | "The request body is larger than this endpoint accepts (N bytes). Shorten the prompt or split the request." | "The request body exceeds the {n}-byte limit (request {requestId}). Shorten the prompt or split the request. We love long reads, but not that long 📚" |
| `accounts_unavailable` | Soft-cool | "No account in the pool can serve 'x' right now (…). Add an account, or wait for an operator to re-enable one." | "No account in the pool can serve '{model}' right now (request {requestId}): {reason}. Add an account, or wait for an operator to re-enable one. Every account is on a coffee break — try later ☕️" |
| `accounts_rate_limited` | Playful | "Every account serving 'x' is cooling down after hitting upstream limits. The request is fine — retry once the cooldown resets." | "Every account serving '{model}' is cooling down after hitting upstream limits (request {requestId}). Retry once the cooldown resets — they're resting up 🌸" |
| `capacity_exhausted` | Playful | "This API key is already serving its maximum number of concurrent requests. Retry shortly, or raise the key's concurrency limit." | "This API key is already serving its maximum number of concurrent requests (request {requestId}). Retry shortly, or raise the key's concurrency limit. It'll free up in a moment 🌊" |
| `provider_capacity_exhausted` | Playful | "Every account is at its concurrency limit. Retry shortly; if it persists, raise the provider's max-inflight or add an account." | "Every account is at its concurrency limit (request {requestId}). Retry shortly; if it persists, raise the provider's max-inflight or add an account. Even the machine needs a rest — chill 🦋" |
| `upstream_queued` | Playful | "The upstream has queued this request. Retry after the stated interval." | "The upstream has queued this request (request {requestId}); retry after {interval}s. You're in line — no cuts 💛" |
| `proxy_pool_capacity_exceeded` | Playful | "Every proxy pool for this provider is at its concurrency limit. Retry shortly, or add a pool or raise its capacity." | "Every proxy pool for this provider is at its concurrency limit (request {requestId}). Retry shortly, or add a pool or raise its capacity. The pools are full right now — chill 🌊" |
| `proxy_pool_provider_capacity_exceeded` | Playful | "Every proxy pool has reached this provider's per-proxy concurrency limit. Retry shortly, raise the limit in the provider's routing settings, or add a pool." | "Every proxy pool has reached this provider's per-proxy concurrency limit (request {requestId}). Retry shortly, raise the limit in the provider's routing settings, or add a pool. The proxies are working overtime — hang tight ⚡️" |
| `proxy_pool_blocked` | Soft-cool | "All proxy pools are saturated for this provider: the upstream refuses every egress configured for it. Replace a blocked proxy, or add one the upstream has not flagged." | "All proxy pools are saturated for this provider (request {requestId}): the upstream refuses every egress configured for it. Replace a blocked proxy, or add one the upstream has not flagged. All roads blocked — time to find a new route 🗺️" |
| `proxy_pool_cooldown` | Playful | "Every proxy pool for this provider is cooling down after upstream failures. Retry once the cooldown resets." | "Every proxy pool for this provider is cooling down after upstream failures (request {requestId}). Retry once the cooldown resets. The proxies are catching their breath — zzz 💤" |
| `proxy_pool_unavailable` | Soft-cool | "No active proxy pool is configured for this tenant and provider. Add one, or route this provider through direct egress." | "No active proxy pool is configured for this tenant and provider (request {requestId}). Add one, or route this provider through direct egress. No bridge to cross — configure a pool first 🏗️" |
| `proxy_pool_unhealthy` | Soft-cool | "configured proxy pool does not support HTTPS tunneling" / "Every proxy pool this route requires is unhealthy or disabled. Repair a pool, or relax the route's pool requirement." | "Every proxy pool this route requires is unhealthy or disabled (request {requestId}). Repair a pool, or relax the route's pool requirement. This bridge looks shaky — repair or reroute 🔧" |
| `invalid_pool_limits` | Soft-cool | "maxInflight must be an integer between 1 and 1000000." | "maxInflight must be an integer between 1 and 1000000 (request {requestId}). Numbers out of bounds — keep them within reason 🧮" |
| `admission_unavailable` | Soft-cool | "The gateway could not admit this request. Retry shortly; if it persists, check the instance's Redis or coordination backend." | "The gateway could not admit this request (request {requestId}). Retry shortly; if it persists, check the instance's Redis or coordination backend. The bouncer stepped out — come back shortly 🚪" |
| `slug_reserved` | Soft-cool | "The provider ID is reserved for a builtin provider" | "The provider ID '{slug}' is reserved for a builtin provider (request {requestId}). This name's taken — pick another alias ✨" |
| `quota_exceeded` | Soft-cool | "This key has used its requests-per-minute allowance. Wait for the window to roll over, or raise the key's rpm limit." | "This key has used its requests-per-minute allowance (request {requestId}). Wait for the window to roll over, or raise the key's rpm limit. You've maxed this window — pace yourself ⏳" |
| `authentication_failed` | Soft-cool | "Invalid API key. Check the key you are sending, or create a new one in API Keys and send it as: Authorization: Bearer <key>." | "Invalid API key (request {requestId}). Check the key you are sending, or create a new one in API Keys and send it as: Authorization: Bearer <key>. Wrong key, right door — double-check and come back 🔑" |
| `policy_rejected` | Soft-cool | "backup export is only available from loopback" / (pesan upstream passthrough) | "This operation is only allowed from a trusted loopback connection (request {requestId}). Not allowed by policy — no hard feelings 🫂" / "The upstream rejected this request on policy grounds (request {requestId}): {message}. The policy said no — and policy has a full-time job 📋" |
| `invalid_request` | Soft-cool | "The request body is not valid JSON. Check for a trailing comma or an unclosed brace." | "The request body is not valid JSON (request {requestId}). Check for a trailing comma or an unclosed brace. Check the shape of what you sent — then resend 🪞" |
| `not_found` | Soft-cool | "No endpoint exists at this path. Check the route against the API reference." | "No endpoint exists at this path (request {requestId}). Check the route against the API reference. Nothing here but dust — check the path 🌙" |
| `link_not_found` | Soft-cool | "Share link is unavailable" | "Share link is unavailable (link {slug}, request {requestId}). This link leads nowhere — check it again 🔗" |
| `link_expired` | Soft-cool | "This share link has expired" | "This share link has expired (link {slug}, request {requestId}). Time for a fresh one 🌷" |
| `link_revoked` | Soft-cool | "This share link's key has been revoked" | "This share link's key has been revoked (link {slug}, request {requestId}). Ask for a new one 📩" |
| `link_disabled` | Soft-cool | "This share link's key is paused" | "This share link's key is paused (link {slug}, request {requestId}). Re-enable it when ready 🌱" |
| `invalid_sequence` | Soft-cool | "Malformed canonical sequence number…" (Responses) | "Malformed canonical sequence number (request {requestId}): {message}. The sequence got scrambled — resend clean 🧩" |
| `invalid_lifecycle` | Soft-cool | "Invalid lifecycle transition…" (Responses) | "Invalid lifecycle transition (request {requestId}): {message}. Lifecycle gone sideways — start over 🔄" |
| `unsupported_field` | Soft-cool | (tidak pernah dikonstruksi — reserved) | "Field '{field}' is not supported on this endpoint (request {requestId}). Remove it from the request. That field doesn't belong here — drop it 🧹" |
| `unsupported_media_type` | Soft-cool | "This endpoint reads JSON, so the request needs a content-type: application/json header." | "This endpoint reads JSON, so the request needs a content-type: application/json header (request {requestId}). We speak JSON here — send JSON 💬" |
| `upstream_conflict` | Soft-cool | (pesan upstream passthrough) | "The upstream reports a conflict (HTTP 409, request {requestId}): {message}. Resource conflict — resolve it first, then retry 🤝" |
| `upstream_unprocessable` | Soft-cool | (pesan upstream passthrough) | "The upstream could not process this payload (HTTP 422, request {requestId}): {message}. Upstream couldn't parse it either — check the payload 🧐" |
| `internal_error` | Soft-cool | "The gateway hit an internal error. Retry; if it persists, the server logs carry the request id." | "The gateway hit an internal error (request {requestId}). Retry; if it persists, quote the request id to support. Even we have bad days — retry, and quote the id if it persists 🐻" |
| `transport_unavailable` | Playful | "The upstream closed the response without reporting a result. Retry; if it keeps happening, the account or pool is unstable." | "The upstream closed the response without reporting a result (request {requestId}). Retry; if it keeps happening, the account or pool is unstable. The connection ghosted us — come back in a moment 👻" |
| `tunnel_setup_failed` | — | telemetry-only (pool health) — tidak sampai ke client | tidak berubah |
| `platform_unavailable` | Playful / Soft-cool | "Upstream returned HTTP 502." (juga: deploy gagal, invoke off, deps not ready) | Upstream: "Upstream returned HTTP {status} (request {requestId}). Retry shortly; if it persists, check the provider's status page. The provider is having a moment — hang tight ☕️". Gateway-own: "This gateway has invoke switched off (request {requestId}). Turn it back on from the dashboard overview to resume routing. Flip the switch back on when ready 🔌" |
| `tenant_capacity_exhausted` | Playful | "This tenant is already serving its maximum number of concurrent requests. Retry shortly, or raise the tenant's concurrency limit." | "This tenant is already serving its maximum number of concurrent requests (request {requestId}). Retry shortly, or raise the tenant's concurrency limit. The tenant is maxed out right now — chill 🏠" |
| `tls_rejected` | — | telemetry-only (pool health) — tidak sampai ke client | tidak berubah |
| `proxy_auth_required` | Soft-cool | (pesan upstream passthrough) | "The proxy requires authentication (HTTP 407, request {requestId}): {message}. The proxy wants a password — authenticate and continue 🛂" |
| `deadline_exceeded` | Playful | "request deadline exceeded" | "The request exceeded its deadline (request {requestId}). Retry, or increase the timeout. Some things just take longer 🐢" |
| `transport_closed` | Soft-cool | "request was cancelled" | "The request was cancelled (request {requestId}). Send it again whenever ready 🙃" |
| `max_connections_exceeded` | — | boot diagnostic (plain Error, bukan GatewayError) | tidak berubah |
| `overloaded` | Playful | "The gateway is at capacity; retry shortly." | "The gateway is at capacity (request {requestId}); retry shortly. It's not you, it's us — come back in a few minutes ☕️" |
| `proxy_unreachable` | — | telemetry-only (pool health) — tidak sampai ke client | tidak berubah |
| `tool_call_loop_detected` | Soft-cool | "Codex whitespace-loop guard tripped: tool call emitted only whitespace argument deltas past the safety threshold" | "Codex whitespace-loop guard tripped (request {requestId}): tool call emitted only whitespace argument deltas past the safety threshold. Caught in a loop — breaking the cycle 🔁" |
| `client_router_denied` | Soft-cool | "No API invocation access for this client." | "No API invocation access for this client (request {requestId}). This router isn't on the guest list — denied, but politely 🤗" |
| `shutting_down` | Playful | "The gateway is shutting down, so this request cannot be served. Retry against a live instance." | "The gateway is shutting down, so this request cannot be served (request {requestId}). Retry against a live instance. Maintenance mode — back in a minute 🧘" |
| `restart_for_update` | — | digabung ke `shutting_down` (alias via reason) | lihat `shutting_down` |
| `upstream_overloaded` | Playful | — (code baru) | "The upstream is overloaded (HTTP 529, request {requestId}). Retry shortly; if it persists, try another model/provider. Even AI has its busy hours 🌙" |

---

## 5. Daftar final code yang diusulkan (52)

51 existing − 1 (`restart_for_update`) + 1 baru (`upstream_overloaded`) + 1
(`request_too_large` sekarang dipakai juga untuk `bodyTooLargeError` — sudah
ada di union) = **52 code aktif** di union.

Tabel ringkas perubahan:

| Code | Perubahan |
| --- | --- |
| `invalid_request` | Makna dibatasi 400/422 |
| `authentication_failed` | Menyerap "missing credential" (401) |
| `policy_rejected` | Menyerap loopback-only/CSRF (403) |
| `not_found` | Menyerap "no such task" |
| `request_too_large` | Menyerap bodyTooLargeError (413) |
| `internal_error` | Menyerap kegagalan write (500) |
| `capacity_exhausted` | Makna dibatasi: key concurrency (429) |
| `upstream_overloaded` | **Baru**: upstream overload (529) |
| `shutting_down` | Menyerap restart_for_update (reason) |
| `restart_for_update` | Dihapus dari union; alias di middleware |
| `platform_unavailable` | `details.reason` wajib untuk kasus gateway-own |

---

## 6. Rencana penerapan

1. **Union & middleware** — `gateway-error.ts` (union, hapus/tambah code),
   `error-lifecycle.ts` (inject `error.requestId`, map alias
   `restart_for_update`).
2. **Pembuat error** — perbaiki semua call site yang tercatat di §1
   (`api-key-auth.ts`, `guard-errors.ts`, `boot/app.ts`, `drain-endpoint.ts`,
   `account-reset.ts`, `export-endpoint.ts`, `console-router-guards.ts`,
   `headroom-guard.ts`, `route-model.ts`, `failure-policy.ts`).
3. **Message** — tulis ulang pesan sesuai tabel §4.5 (lead formal + requestId
   di teks + tail hangat; satu pass per file).
4. **Console** — sesuaikan `ConsoleDomainError` bila ada yang ikut pola
   (opsional; console sudah bebas-string).
5. **Test terdampak** (harus lulus setelah ubah):
   - `test/transport/gateway-error-envelope.test.ts`
   - `test/transport/failure-policy.test.ts` + inferhub mapping
   - `test/transport/terminal-failure.test.ts`
   - `test/transport/body-policy.test.ts`
   - `test/transport/retry-policy.test.ts`
   - `test/security/admission.test.ts`, `test/security/api-key-auth*` (kalau ada)
   - `test/providers/account-health-invalidation.test.ts`
6. **Risiko:** perubahan code = breaking contract; saran fase:
   - Fase 1 (additive): inject `error.requestId` + requestId di lead message,
     tambah `upstream_overloaded`, perjelas message — tanpa menghapus apa pun.
   - Fase 2: batasi makna `invalid_request`/`authentication_failed` (ubah
     call site), gabung shutdown code.
   - Fase 3: update `documentation/reference/errors.md` + changelog.

---

## 7. Lampiran: tempat kode bermasalah

| Code | File utama |
| --- | --- |
| `invalid_request` | `security/api-key-auth.ts`, `transport/guards/guard-errors.ts`, `transport/guards/body-policy.ts`, `boot/app.ts`, `transport/guards/auth-guard.ts`, `console/auth/account-reset.ts`, `console/backup/export-endpoint.ts`, `console/console-router-guards.ts` |
| `authentication_failed` | `security/api-key-auth.ts`, `export-endpoint.ts`, `failure-policy.ts` |
| `shutting_down` / `restart_for_update` | `transport/shutdown-notice.ts`, `transport/request/state.ts` |
| `capacity_exhausted` | `security/admission/reasons.ts`, `failure-policy.ts` |
| `platform_unavailable` | `transport/guards/readiness-guard.ts`, `transport/guards/auth-guard.ts`, `console/routing/pools/relay-deploy.ts`, `failure-policy.ts` |
| `overloaded` | `transport/guards/headroom-guard.ts` |
