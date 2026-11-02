# Cleanup proposal — transport

Status: proposal, belum diimplementasikan.
Sumber: audit statis (lihat README).

## Ringkasan

- Files: 77 · kandidat dead exports: 88

## Kandidat

- `State/deps/helper per req di dispatch/routing/request/network — lihat output audit penuh.`

## Catatan

Area kedua terbesar. Fokus pada tipe interim yang hanya dipakai alur lokal, jangan sentuh contract antar-lapis (RoutePlan, PreparedRequest).

## Verifikasi

1. Untuk tiap kandidat: grep lintas seluruh repo (termasuk .tsx/docs/scripts)
   untuk re-export alias & magic string.
2. Privatkan bila internal-only; hapus bila benar-benar tak dipakai.
3. Jalankan `bunx tsc --noEmit`, `bun run test:backend`,
   `bun run dashboard:typecheck`, dan golden payload protocol.
