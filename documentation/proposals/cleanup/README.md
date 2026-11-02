# Cleanup — src/ per-area proposals

Status: proposals, belum diimplementasikan. Semua klaim "dead export" berasal dari
audit statis `D:\tmp\scratch\audit-all-src2.ts` (scan seluruh `src/`, `test/`,
`scripts/`, dan `dashboard/src/` `.ts`+`.tsx`). Setiap kandidat WAJIB diverifikasi
manual sebelum dihapus/diprivatkan: sebuah symbol yang "dead" menurut scan bisa
dipakai lewat re-export alias, barrel import, atau string magic.

## Metodologi (berlaku untuk semua area)

1. **Re-run audit** — `bun D:\tmp\scratch\audit-all-src2.ts`.
2. Per kandidat, cek 3 hal:
   - `grep` seluruh repo (termasuk `.tsx`, `docs`, `scripts`).
   - re-export/alias (`export { x as y }`, barrel `export * from`).
   - magic string / runtime lookup (mis. `PROVIDER_CAPABILITIES[providerId]`).
3. **Privatkan** (hapus `export`) bila hanya internal; **hapus** bila benar-benar
   tak dipakai & bukan kontrak API.
4. Guard tiap change: `bunx tsc --noEmit`, `bun run test:backend`,
   `bun run dashboard:typecheck`, lalu golden payload protocol (chat/messages)
   untuk memastikan tidak ada perubahan wire bytes.

## Ringkasan per area

| Area | Files | Kandidat dead symbols | Status |
| --- | --- | --- | --- |
| boot | 5 | 4 | proposal |
| config | 10 | 6 | proposal |
| console | 127 | 102 | proposal |
| network | 19 | 12 | proposal |
| observability | 18 | 31 | proposal |
| persistence | 23 | 40 | proposal |
| protocol | 45 | 1 | **selesai** (commit `1b7a937b`) |
| providers | 225 | 422 | proposal |
| security | 21 | 18 | proposal |
| transport | 77 | 88 | proposal |
| workers | 8 | 16 | proposal |
| shared | 4 | 0 | tidak perlu |
| types | 0 | 0 | kosong |

File detail per area ada di `documentation/proposals/cleanup/`.
