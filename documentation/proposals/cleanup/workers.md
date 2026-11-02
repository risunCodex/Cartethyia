# Cleanup proposal — workers

Status: proposal, belum diimplementasikan.
Sumber: audit statis (lihat README).

## Ringkasan

- Files: 8 · kandidat dead exports: 16

## Kandidat

- `Scheduler/lease/checkin helpers — lihat output audit penuh.`

## Catatan

Cek interaksi dgn health-routing sebelum privatisasi.

## Verifikasi

1. Untuk tiap kandidat: grep lintas seluruh repo (termasuk .tsx/docs/scripts)
   untuk re-export alias & magic string.
2. Privatkan bila internal-only; hapus bila benar-benar tak dipakai.
3. Jalankan `bunx tsc --noEmit`, `bun run test:backend`,
   `bun run dashboard:typecheck`, dan golden payload protocol.
