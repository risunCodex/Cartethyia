> # ARCHIVED — UNTRUSTED
>
> This file was archived on 2026-10-28. It is a **point-in-time record**, not a
> description of current behavior: every `file:line`, symbol, path, and
> measurement below was true when it was written and has not been kept in sync.
> Do not read it to answer a question about the current codebase, and never cite
> it as evidence. The shipped implementation superseded this investigation: the
> Turing SDK is bundled at `vendor/turing-sdk/` and the per-account binding is
> described in [the archived Buddy device-binding note](2026-10-30-buddy-device-binding.md).

# Reverse notes — TuringShield `x-device-token` (WorkBuddy/CodeBuddy)

Status: **investigasi** (bukan implementasi final). This note preserves the
recorded measurements; the raw binary fixtures are not present in the current
worktree.

## Apa yang terbukti (bukti langsung)

1. **SDK native** (`turing_sdk.node` + `TuringShieldSDK.dll`, varian `overseas`)
   menghasilkan token asli dengan memanggil:
   - `configure(400111, "WorkBuddy", "4.12.1")`
   - `fetchDeviceToken({ usingCachedMessage: false, includesOutdatedMessage: true,
     includesDeviceInfo: true, timeoutMs: 15000 })`
   - Output: `v3:AAAA…` (base64), panjang bervariasi **970–1006** per fetch.
2. **Wire capture** (mitmdump + elevasi proxy WinHTTP):
   - `POST https://www.turingfraud.net/`
     - `User-Agent: TMFShark/1.0`
     - `Content-Type: application/octet-stream`
     - body ~9.3–9.4 KB (biner), resp `200` body 297 B.
   - Response (297 B) berisi **base64 chunk** yang decode → 20 byte
     (mis. `Wr7hapLv6gZU2htmUbmhchaxy+I=` → `5abee16a…`).
   - Format response tampaknya envelope dengan header `0a 00 01 1c 2c 3c
     0b 1d 00 00 …` lalu field string.
3. **Struktur body request**: bukan JSON; ada string literal `test_keyid`,
   identifier 32 digit yang `03099226091122330000905747638120`, dan byte acak
   (high entropy) — kemungkinan gabungan info-device + metadata + payload
   terenkripsi. Hanya ~117/9351 byte identik antar fetch (nonce/timestamp).

## Pipeline yang diduga (dari strings DLL)

- collect device fingerprint → **JCE V3** serialize → **XXTEA** encrypt →
  **AES-256-CBC** (+ RSA public key embedded, 2048-bit / 1024-bit) → base64.

## Batas

- Skema JCE field & turunan kunci **belum direkonstruksi penuh**; body mentah
  tidak cukup untuk mereplikasi tanpa memahami format internal + kunci.
- Emulator murni penuh memerlukan **disassembly DLL** (1.5 MB C++ stripped),
  atau mengekstrak skema JCE dari library Tencent yang sama.

## Langkah potensial selanjutnya

- Disasm `TuringShieldSDK.dll` untuk fungsi `createTSObject` → `configure` →
  `fetchDeviceToken`, rekonstruksi serialisasi & cipher.
- Atau cari implementasi JCE/XXTEA Tencent open-source (Qoder/dll) untuk basis.
- Setelah wire len dipahami, implementasikan emulator murni di TS dengan
  input per-akun (supaya tiap akun punya fingerprint berbeda).
