# Qoder — Credits, Claim System & Device Identity (dipangkas 2026-11-05)

> Konsolidasi riset 2026-10-29 → 2026-11-04. Hanya temuan terverifikasi
> live yang dipertahankan; pengulangan antar sesi digabung.

---

## 1. Daily Credit Campaign — Resep yang Terbukti

### 1.1 Endpoint (base `https://openapi.qoder.sh`)

| Endpoint | Method | Body / catatan |
|---|---|---|
| `/api/v1/deviceToken/refresh` | POST | `{refresh_token, machine_id, machine_token}` → rotasi `dt-` + `drt-` (keduanya wajib ditulis balik) |
| `/sash/api/v1/me/campaigns` | GET | daftar campaign (header desktop wajib) |
| `/sash/api/v1/me/campaigns/{id}/claim` | POST | `{}` — **`campaignId` UUID**, bukan `campaignKey` |
| `/sash/api/v1/me/campaigns/{id}/reward` | GET | `404 GRANT_NOT_FOUND` = tidak ada grant |

### 1.2 Kriteria & status

- Campaign CREDITS: `actionType === "CLAIM_BENEFIT"`, `benefit.kind === "CREDITS"`.
- Sukses: `status ∈ {CLAIMED, GRANTED, SUCCESS}` → +100, ALL_MODELS, 30 hari.
- `failureCode === "SAME_PERSON_ALREADY_CLAIMED"` / `status === "BLOCKED"` → sudah claim.
- HTTP 409 / `ALREADY_CLAIMED` / `REPLAYED` → idempotent.
- List visibility *flutters* (bisa hilang beberapa menit); claim hanya saat `CLAIMABLE`.

### 1.3 Temuan kunci

1. **Grant per-akun, server-side** — `/reward` 404 untuk tanpa grant, meski list menampilkan campaign.
2. **Identity tidak mengunci claim** — generated, kosong, random, atau omit machine headers diterima pada akun yang sudah grant (control 2026-10-30). Tapi lihat §4: CREDITS campaign baru **terlihat** dengan real UMID.
3. **"Same person" = per uid + per campaign**, bukan IP/device. Akun yang sudah claim campaign tertentu permanen blocked; list menyembunyikannya.
4. **Quota = ground truth** — sukses claim menaikkan `addOnQuota.total` 100 → 200.
5. **Promo `VIEW_DETAILS`** (`act-20261021-273`, `act-20261020-944`) tidak punya benefit; claim-nya 200 tapi tidak menambah kredit.

### 1.4 Hasil agregat

- 53 akun (10-29): 31 claimed +100 (3100), 22 no-grant.
- Roster 141 akun (11-01): 16 pegang grant ≥100; claim final +300 (Sunny Koding, Jinxi, Suni Kontak); 13 same-person blocked; 125 no-grant.
- Campaign berganti per periode: `act-20261027-489` → `act-20261102-503` (11-04). Roster 16 akun pada campaign baru: hanya `papa mama` yang menunjukkan CREDITS (11-04).

---

## 2. Activity-Claim System (welcome trial + credits)

Dari reversing `qoder-ide` 1.37.0 (Linux deb):

```
GET  {Inference}/algo/api/v2/activity                       → {activities:[{activityId}]}
GET  {OpenApi}/api/v2/activity/claim/eligibility             → {data:[...]}
POST {OpenApi}/api/v2/activity/claim?activityId=<id>         → code:0
```

- `claimActivity` hanya untuk item yang muncul di list (server-provisioned, bukan client-enumerable).
- Endpoint hidup & callable dengan COSY signer, tapi **tidak ada activity terprovisi** untuk akun lokal.

### Signature schemes (verified)

1. **COSY Bearer** (chat/`/algo`): AES-128-CBC + RSA PKCS1 + alphabet scramble, md5 chain `payload\ncosyKey\ndate\nbody\npath`. Untuk GET, sign body **""** (bukan `{}`).
2. **Gateway HMAC "Signature"** (non-chat, activity claim): `secret = sha256("cosy:"+ideVersion+":"+machineToken)`, `bodyHash = sha256(String(contentLength))`, `sts = ${method} ${path} ${requestId} ${machineToken} ${ts} ${bodyHash}`, HMAC-SHA256. Header: `X-Request-Id`, `X-Client-Timestamp`, `Authorization: Signature`, `X-IDE-Platform`, `X-Version`, `X-Machine-*`.
3. **Go static headers** (`qoderStaticHeaders`): `appcode`, `date`, `signature = md5("cosy&<b64secret>&<date>")`.

⚠️ Host split: COSY Bearer → `/algo` (inference); openapi host menerima plain `Bearer dt-` (COSY di openapi → 401).

### Provision matrix (11-01)

Fresh account didorong lewat segala jalur — `activities []`, `eligibility []`, plan Free, quota 0. Trial 2-week Pro + 300 tidak muncul setelah: ganti credential kind, ganti machine identity, selesaikan interaksi, atau email welcome cohort. Kesimpulan: trial di-seed server-side per cohort; endpoint-nya ada, tapi tidak terprovisi untuk akun ini.

---

## 3. UMID / Device Identity

### 3.1 Komponen

| Binary | Peran | Sumber identitas |
|---|---|---|
| `runtime-info.exe` (Windows PE) | thin host: muat `sgsdk.dll`, `initUMID` → `getSecurityToken`, VM scoring lokal | hardware-derived, stateless |
| `sgsdk.dll` (7.3MB, signed Alibaba) | SecurityGuard SDK: engine UMID/SG | machine-bound |
| `runtime-info` (Linux ELF) | host sama; collector baca `/sys`, `/proc`, `dmidecode`, `hdparm`, `lshw` | **seed file** `~/.config/.locale_cfg` |

### 3.2 Hasil eksperimen

- Seed → token deterministik & offline: seed sama → token sama; 1-byte berubah → token beda; timestamp tidak berpengaruh.
- Windows exe stateless (tidak ada state file); token fungsi murni hardware; `--account-stdin` tidak mengubah token per akun.
- ELF juga tidak peduli akun — token ikut seed.
- VM detection: skor DMI vendor, cgroup, hypervisor flag, modul vboxguest/vmci/vmbus.

### 3.3 Verdict server

- Campaign CREDITS **tidak butuh** identitas asli (generated/kosong/random/omit semua jalan di akun yang sudah grant).
- Tapi **CREDITS campaign hanya terlihat dengan real UMID** (lihat §4) — `requireMachineIdentity()` di IDE bundle gate visibilitas, bukan eligibility.
- Identity minting tidak bisa menciptakan grant yang tidak ada.

### 3.4 Implementasi di Cartethyia

- `qoder-umid.ts`: fallback software-generated identity (`P1gA` + 84 base64url, type/code 18-hex, `isVm:false`), deterministik per akun (SHA-256 account id), tanpa subprocess/WSL/registry.
- Bridge priority: Linux native `elf-*` → mini-ELF container → generated; macOS native `macho-*` → generated; Windows WSL `wsl-elf` → `runtime-info.exe` → mini-ELF via WSL → generated.
- PAT → jobToken exchange **mengikat machine identity** (`machine_id` + `machine_token` di body) — raw PAT 401 di sash, setelah exchange dengan machine binding 200.

---

## 4. Revalidation 2026-11-04 — Real UMID on Windows

- Campaign `act-20261102-503`; claim via `campaignId` UUID.
- **Real UMID (`runtime-info.exe`) vs generated**: generated → promo-only (CREDITS hidden); real → CREDITS `CLAIM_BENEFIT` + `CLAIMABLE` muncul, claim sukses +100. Real UMID bekerja walau di bawah Hyper-V (`vmInfo.isVm:true`, `vmTypeCode:14`).
- Sash host = `openapi.qoder.sh` (bukan qoder.com).
- Response campaigns shape = `{showCampaign, claimable, campaigns:[...]}` langsung (tanpa `.data`).
- Header bekerja: `Authorization: Bearer <dt-…>`, `User-Agent: Qoder`, `Cosy-ClientType: 10`, `Cosy-Version: 1.1.81`, + enam `cosy-machine*` UMID.

---

## 5. Worker Fix & Manual Claim (11-04)

- `tryClaimDaily` hanya claim campaign **CREDITS-kind** (`CLAIMABLE`); promo tidak lagi di-claim.
- `already_claimed` hanya dilaporkan saat CREDITS-kind `CLAIMED`.
- `probeDailyClaim` terminal saat claimed/already_claimed.
- Console endpoint `POST /accounts/:id/claim-qoder-credits` + button `ClaimQoderCreditsButton`; unit tests `test/console/qoder-credits-claim.test.ts`.

---

## 6. Evidence

- Account exports: `C:/Users/Aria/Desktop/qoder-accounts-2026-11-01-merged-all.json` (141), `qoder-accounts-2026-11-04T08-59-46-438Z.json` (16).
- UMID bridge: `vendor/qoder-umid/runtime-info` (ELF), `vendor/qoder-umid/umidpack/runtime-info.exe` + `sgsdk.dll`.
- Probe tooling: `scripts/provider-probing/qoder/quota/probe-qoder-credits.ts`.
- Proxies: `http://{altaria,ballast,caboose,…}.proxy.rlwy.net:<port>` (40 endpoints).
