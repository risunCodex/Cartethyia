# Cleanup proposal — providers

Status: proposal, belum diimplementasikan.
Sumber: audit statis (lihat README).

## Ringkasan

- Files: 225 · kandidat dead exports: 422

## Kandidat

- `Lusinan tipe OAuth/client/state/helper per integrasi (antigravity, buddy, qoder, openai-compat, dll) — lihat output audit penuh.`

## Catatan

Area terbesar. Prioritaskan: (1) integrasi yang tak lagi aktif, (2) tipe helper murni, (3) konstanta magic yang hanya dipakai dalam satu file. JANGAN sentuh adapter terdaftar/provider metadata yang dipakai discovery.

## Verifikasi

1. Untuk tiap kandidat: grep lintas seluruh repo (termasuk .tsx/docs/scripts)
   untuk re-export alias & magic string.
2. Privatkan bila internal-only; hapus bila benar-benar tak dipakai.
3. Jalankan `bunx tsc --noEmit`, `bun run test:backend`,
   `bun run dashboard:typecheck`, dan golden payload protocol.
