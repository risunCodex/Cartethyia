# Cleanup proposal — console

Status: proposal, belum diimplementasikan.
Sumber: audit statis (lihat README).

## Ringkasan

- Files: 127 · kandidat dead exports: 102

## Kandidat

- `Tipe contracts & deps di auth/backup/cli-tools/observability/oauth/quota/remote-support/routing/settings/share/dashboard-assets — lihat output audit penuh.`

## Catatan

Area terbesar kedua. Banyak tipe contracts ternyata dipakai dashboard via data/contracts.ts (sudah ikut dicek), sisanya deps internal — privatkan. Berhati-hati dgn *RoutesConfig & *Store interfaces yang dipakai registrasi.

## Verifikasi

1. Untuk tiap kandidat: grep lintas seluruh repo (termasuk .tsx/docs/scripts)
   untuk re-export alias & magic string.
2. Privatkan bila internal-only; hapus bila benar-benar tak dipakai.
3. Jalankan `bunx tsc --noEmit`, `bun run test:backend`,
   `bun run dashboard:typecheck`, dan golden payload protocol.
