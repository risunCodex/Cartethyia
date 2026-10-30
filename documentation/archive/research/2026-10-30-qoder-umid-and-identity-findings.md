# Qoder UMID and identity findings (2026-10-30)

Follow-up to [the daily credit campaign probe](2026-10-29-qoder-daily-credit-campaign.md).
This combines the native identity reverse engineering with the later
same-account controls that corrected the original machine-token theory.

## Components identified

| Binary | Role | Identity source |
|---|---|---|
| `runtime-info.exe` (Windows PE, Rust host) | thin host: loads `sgsdk.dll`, calls `initUMID` â†’ `getSecurityToken` (+ `setActiveAccount`), does VM scoring locally, prints JSON | **hardware-derived, one per machine, stateless** |
| `sgsdk.dll` (7.3 MB, **signed ALIBABA CHINA NETWORK TECHNOLOGY**) | Alibaba SecurityGuard SDK: the actual UMID/SG engine; dynamic API resolution, encrypted state | machine-bound |
| `runtime-info` (Linux ELF, same Rust host) | same host pattern for Linux; collector reads `/sys`, `/proc`, `dmidecode`, `hdparm`, `lshw` | **seed file** (`~/.config/.locale_cfg`) |

Key strings recovered from the ELF:
- Cookie/seed keys **hardcoded** in the binary (obfuscated table, `.` delimited):
  `yooVto7srhDgkOv6`, `FAvgcHncgkVhZ4vC`, timestamp key `bdb13dc551d3db53`.
- Endpoints: `https://umid.daily.alibaba.net/repPc.json` (+ pre-prod/alt hosts),
  query `%s?e=%d&pn=%s&os=%d&sv=%s&pv=%s&pt=%d`, version `1.5.0`.
- Collectors: `/sys/class/dmi/id/*` (board/bios/product/sys vendor),
  `/proc/cpuinfo` flags, `/sys/class/net/*/address` (MAC),
  `dmidecode -t 4` (CPU ID), `-t baseboard` (Serial No),
  `hdparm -i` (disk serial), `lshw -class disk`,
  `/proc/sys/kernel/random/uuid`, `/dev/zero`, `xxh64`.
- VM detection (ELF, host-side): DMI vendors, cgroup (`docker/lxc/containerd`),
  `/proc/cpuinfo` hypervisor flag, vboxguest/vmci/vmbus modules,
  `/sys/hypervisor/type` â€” with a *scored* verdict ("weak indicators",
  "strong single indicator").

## Experimental results

1. **Seed â†’ token is deterministic and offline.** Same seed â‡’ same token
   (T1==T2==T4). One-byte seed change â‡’ different token (T3). Timestamp field
   does not affect the token (T5).
2. **Fresh random seeds produce valid-shaped tokens.** A brand-new seed with
   random keys and random base64-ish values yields a `P1gA`-prefixed,
   88-char token (A/B tests). Seed farming offline works.
3. **The Windows exe ignores `~/.config/.locale_cfg`** (leaves it untouched).
4. **The Windows exe is stateless on disk** â€” no state file appears anywhere
   (scanned user dirs, ProgramData, Public, registry HKCU/HKLM). Token is a
   pure function of the machine's hardware.
5. **`--account-stdin`/`setActiveAccount` does NOT derive per-account tokens**
   on Windows: the token stayed constant across accounts (after a one-time
   re-derivation on first account feed, it locked).
6. **The ELF equally ignores the account argument** â€” token follows the seed,
   not the account.

## Server-side verdicts (latest live probes)

The initial cross-account tests incorrectly attributed `NO CREDITS` to
generated tokens. A later same-account control on 2026-10-30 showed that the
machine headers do **not** gate the daily CREDITS campaign:

- On one already-granted account, generated SHA-256, empty, Windows-exe, and
  random machine headers all showed `CLAIMED` with the same fresh `dt-` token.
- On another already-claimed account, DLL-FFI, garbage, and omitted machine
  headers also showed `CLAIMED`.
- Thus a genuine SG token, a non-VM token, and any machine headers are not
  prerequisites for this campaign surface. The earlier different-account,
  different-time comparison was confounded.

The observed reasons for `NO CREDITS` are grant absence (`/reward` returns
`404 GRANT_NOT_FOUND`), daily-window timing (10:00 Asia/Shanghai reset), or an
invalid `dt-` access token. Identity minting cannot create a missing grant.
These controls establish the campaign behavior tested; they do not prove that
other Qoder endpoints ignore device identity.

## Architecture conclusion

- **Native identity generation:** technically solved via the vendor bridge.
  Windows PE is hardware-bound; ELF/Mach-O identity can be replayed from its
  seed. The ELF seed mechanism is useful when a stable native identity is
  needed by other surfaces.
- **Daily CREDITS claims:** do not require a genuine identity or per-account
  seed. Generated, empty, random, and omitted machine headers were accepted
  on already-granted accounts. Keep identity persistence for deterministic
  replay and other integrations, not as a campaign-grant prerequisite.
- Reimplementing seedâ†’token in pure JS would require breaking the SG crypto
  (out of scope); running the ELF without WSL would require a bundled Linux
  runtime.

## Practical recipe

1. Check that the account has a grant and a valid `dt-` token; `404
   GRANT_NOT_FOUND` means there is no grant to claim.
2. Read the campaign list and claim only an explicitly `CLAIMABLE` CREDITS
   entry.
3. Machine headers may be genuine, generated, empty, or omitted for the tested
   CREDITS surface; identity headers do not make an ungranted account eligible.
4. Persist rotated device and refresh tokens. Keep native seeds only when
   deterministic identity replay is needed for another surface.
