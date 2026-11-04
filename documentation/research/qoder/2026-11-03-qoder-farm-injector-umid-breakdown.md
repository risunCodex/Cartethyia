# Qoder Target: Pro Trial 300 Credit — Breakdown

Tanggal: 2026-11-03
Scope: `Public/AUTO/qoder-farm`, `Public/AUTO/qoder_injector`, `Cartethyia/vendor/qoder-umid`.
Target tunggal: **Pro Trial 300 credit** (grant via jalur resmi). Hal lain
(free calls 800 qwen, activity claim `ultimate_200_free_invoke`, dsb.) di luar
fokus.

---

## 1. Target & definisi sukses

- **Sukses** = akun mendapat **`PLAN_TIER_PRO_TRIAL`** / `personal_professional_trial`
  / `userTag` "Pro Trial" dengan **quota total ≥ 300**.
- Verifikasi final: `GET /api/v2/user/plan` + `GET /api/v2/quota/usage`
  (bearer `jt-*`).

---

## 2. Prasyarat (wajib, dari operator)

| # | Prasyarat | Kenapa |
|---|---|---|
| 1 | **Fresh akun + PAT, belum login di mana pun** | Login pertama me-* device (machine_id/UMID). Akun terikat device lain → inject di device beda ditolak/revoked |
| 2 | **UMID fresh & disimpan per akun** | Identitas deterministik dari seed `.locale_cfg`. Seed hilang / ganti mesin → identitas berubah → **langsung revoked** |
| 3 | **Request chat lite/model free dulu, baru inject** | Aktivasi Pro Trial baru terbuka setelah akun benar-benar dipakai chat model free/lite |

---

## 3. Alur tunggal menuju Pro 300

```
1. Fresh signup (qoder_signup*.py) → akun baru
2. Device-flow (PKCE S256) → Google SSO (Camoufox + residen proxy WAJIB)
   → consent + ToS → session qoder.com valid
3. Buat PAT: POST /api/v1/me/personal-access-tokens → pt-* (64-char) → pats_master.jsonl
4. Umid fresh per akun → SIMPAN seed (must, lihat §5)
5. Login Qoder CLI dgn PAT (QODER_PERSONAL_ACCESS_TOKEN) → Pro Trial 300
   = `qoder_claim_trial.py` (device flow + machine_id) ATAU
   `qoder_injector.py` (HOME fresh → CLI login → jt → eligibility → claim)
6. Verifikasi: user/plan + quota/usage → 300 credit
```

---

## 4. Komponen & status

| Komponen | Peran menuju Pro 300 | Status |
|---|---|---|
| `qoder_device_pat.py` | Farm PAT (fresh akun/SSO/PAT) | Terbukti (12 PAT) |
| `qoder_claim_trial.py` | Claim Pro Trial via device-flow + machine_id | Terbukti (verify 12/12) |
| `qoder_injector.py` | High-quality per-PAT: CLI login → jt → eligibility → claim → verify | Terbukti |
| `ultimate_injector.py` | Token-only exchange → status → trial | **Tidak dipakai** (perlu kredensial mesin asli) |
| `inject_qoder_pat.py` | Inject PAT ke 9router | Opsional, setelah trial |
| `vendor/qoder-umid` + `qoder-umid.ts` | UMID asli + seed replay per akun | Dipakai utk prasyarat #2 |

---

## 5. UMID — penyimpanan seed (krusial)

- Pakai `mintQoderNativeIdentity()` utk dapatkan `{identity, seed}`, **simpan
  seed per akun** (di `provider_accounts.native_identity.seed` di Cartethyia,
  atau di `claim_trial_results.jsonl` utk aliran farm).
- Jangan pernah buang seed: kalau hilang, identitas beda → device binding
  tidak konsisten → revoked.
- `qoder_claim_trial.py` saat ini generate `machine_id` sekali pakai tanpa
  simpan — **harus diubah** agar menulis seed (lihat §6).

---

## 6. Hal yang harus dibenahi (menuju target Pro 300)

1. `qoder_claim_trial.py`: **simpan seed/machine_id** per akun (reuse replay
   `qoder-umid.ts`), bukan generate sekali pakai.
2. `ultimate_injector.py`: tidak dipakai untuk target ini; kalau mau dipakai,
   harus kirim `Cosy-MachineToken/Type/Code` asli (bukan spoof random).
3. Selaraskan format `machineType` (16 vs 18 hex) dengan output `runtime-info`
   asli sebelum verifikasi.
4. Pastikan alur "request chat free dulu" dijalankan sebelum inject.

---

## 7. Referensi file

- `documentation/research/qoder/2026-10-29-qoder-credits-claims-identity.md`
- `documentation/research/qoder/2026-11-01-qoder-chat-wire-verification.md`
- `Cartethyia/vendor/qoder-umid/README.md`, `MINI-BUNDLE.md`, `umidpack/README.md`
- `src/providers/integrations/qoder/qoder-umid.ts`
