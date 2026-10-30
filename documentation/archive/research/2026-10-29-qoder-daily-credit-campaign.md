# Qoder daily credit campaign â€” raw findings (`act-20261027-489`)

Raw reverse-engineering notes from live probing of the Qoder production gateway
on 2026-10-29. This is research output, not a feature guide â€” it records what
was observed, the recipe that worked, and the dead ends. Endpoint behavior can
drift.

The [UMID and identity follow-up](2026-10-30-qoder-umid-and-identity-findings.md)
corrected the original assumption: machine identity is not a gate for the
daily CREDITS campaign. The Buddy/Turing device-token investigation is a
separate provider and protocol.

---

## Objective

Claim the daily 100-credit campaign (`act-20261027-489`) for as many accounts
as possible from an exported account file, using uniquely minted device
identities per account. Constraints from the request:

- Proxy per account preferred but not mandatory.
- Two accounts kept as reserve (`Alma Agutah`, `Dimas Gurutopia`); later tested.
- Live per-account output; no silent/blocked runs.
- Credentials only â€” no client, no device-unlock theories.
- Refresh token and device must be unique per attempt.

## Environment / assets

| Asset | Location |
|---|---|
| Accounts (45, early) | `C:/Users/Aria/Desktop/qoder-accounts-2026-10-29T12-53-38-453Z.json` |
| Accounts (53, final) | `C:/Users/Aria/Desktop/qoder-accounts-2026-10-29T15-37-01-530Z.json` |
| UMID bridge (Linux ELF, via WSL) | `vendor/qoder-umid/runtime-info` |
| Seed file (WSL) | `/home/risun/.config/.locale_cfg` |
| Official bundle | `D:/tmp/qodercli/npm-package/package/bundle/qoder-worker-runtime.mjs` |
| Windows PE identity | `D:/tmp/qodercli/cli-state/.bin/umid-win32-x64-48d1294f147c9d89/` |
| Donor hub reference | `Public/qoder2api-hub/qoder_accounts.py` |
| Proxies | 5 Ã— `*.proxy.rlwy.net` (altaria/ballast/caboose) |

## Endpoints (base `https://openapi.qoder.sh`)

| Endpoint | Method | Use |
|---|---|---|
| `/api/v1/deviceToken/refresh` | POST | `drt-` â†’ `dt-`; body `{refresh_token, machine_id, machine_token}` |
| `/sash/api/v1/me/campaigns` | GET | campaign list (desktop identity headers required) |
| `/sash/api/v1/me/campaigns/{id}/claim` | POST | claim (`{}`) |
| `/sash/api/v1/me/campaigns/{id}/reward` | GET | grant probe; `404 GRANT_NOT_FOUND` = no grant |

## Recipe that worked

1. **Fresh mint:** `rm -f /home/risun/.config/.locale_cfg` then
   `runtime-info 3` â†’ fresh `{machineToken, machineType, machineCode}`. Token
   starts `P1gAâ€¦`. The `env` arg (0,3,4,5,6,7) is NOT a slot â€” same token per
   platform. Restoring a seed replays the identical token (proven T1==T3==T4).
2. **Headers:** `User-Agent: Qoder`, `Cosy-ClientType: 10`,
   `Cosy-Version: 1.1.64`, `cosy-machineid`/`cosy-machinetoken` (= UMID token),
   `cosy-machinetype`, `cosy-machinecode`, `cosy-machineos: x86_64_linux`,
   `cosy-machinehostname`.
3. **Refresh:** `POST /api/v1/deviceToken/refresh` with
   `{refresh_token, machine_id: authState.machineId, machine_token}`. Response
   rotates both `device_token` (`dt-â€¦`) and `refresh_token` (`drt-â€¦`) â€” **both
   must be written back to the account JSON**.
4. **Probe:** `GET /sash/api/v1/me/campaigns`; the CREDITS campaign has
   `actionType === "CLAIM_BENEFIT"` / `benefit.kind === "CREDITS"`.
5. **Claim:** when `claimStatus === "CLAIMABLE"`, `POST .../claim` with `{}`.
6. **Result mapping:**
   - `success !== false` + `status âˆˆ {CLAIMED, GRANTED, SUCCESS}` â†’ success
     (+100, ALL_MODELS, 30 days).
   - `failureCode === "SAME_PERSON_ALREADY_CLAIMED"` / `status === "BLOCKED"`
     â†’ already claimed / blocked.
   - HTTP 409 / `ALREADY_CLAIMED` / `REPLAYED` â†’ already claimed (idempotent).

## Findings

1. **Grant is per-account, server-side.** All accounts structurally expose the
   same campaign key (`act-20261027-489`), but whether a claim succeeds is a
   per-account server decision. `GET .../reward` returns **404 GRANT_NOT_FOUND**
   for accounts without a grant, even when the list shows the campaign.

2. **List visibility flutters; eligibility does not.** The CREDITS entry
   appears/disappears from the list within minutes (observed: an account seen
   `CLAIMABLE` in a raw dump showed `NO CREDITS` 2 minutes later). This affects
   *when* you can claim, not *whether* the grant exists.

3. **Two other campaigns are promos, not claim targets:**

   | campaignKey | actionType | benefit |
   |---|---|---|
   | `act-20261021-273` | `VIEW_DETAILS` | `undefined` |
   | `act-20261020-944` | `VIEW_DETAILS` | `undefined` |

   Both report `claimStatus=CLAIMABLE` but carry no `benefit` â€” they are info
   banners (`qoder.com/community-boost`, `qoder.com/pricing`). This is why some
   accounts show "2 campaigns but cannot be hit".

4. **Account type is not a predictor.** Non-GSuite accounts are mixed:
   `Dimas Gurutopia` (non-GSuite) claimed successfully; `DMAZRH GT`
   (non-GSuite) has no grant. No uid-prefix or createdAt pattern separates
   eligible from not (checked prefixes `019câ€¦`, `019eâ€¦`, `019fâ€¦`, `01a1â€¦`;
   claimed createdAt spans 10-27..10-28, others 10-28..10-29 â€” overlapping).

5. **Proxy vs direct.** Proxies help with per-IP throttle (same account+proxy
   that failed succeeded minutes later), but don't affect eligibility â€” no-grant
   accounts fail on every proxy and on direct.

6. **Throttle is temporal, bursty.** After a run of successful claims, further
   attempts return `NO_CREDITS` (list hides the entry) until a pause. Claim
   times clustered in bursts; observed inter-burst gaps ~2.7 min and ~6.4 min.

## Generated mint (no WSL, no registry touch)

To avoid executing the bridge binary / touching WSL or the real registry, a
**software-generated identity** mode is implemented in Cartethyia
(`src/providers/integrations/qoder/qoder-umid.ts`), gated by
`CARTETHYIA_QODER_UMID_GENERATED=true`.

It mirrors the real bridge's output shape (verified against a live WSL ELF
mint):

| Field | WSL ELF (live) | Generated | Match |
|---|---|---|---|
| `machineToken` | `P1gA` + 84 base64url (88) | `P1gA` + 84 base64url (88) | âœ… |
| `machineType` | 18 hex | 18 hex | âœ… |
| `machineCode` | 18 hex | 18 hex | âœ… |
| `isVm` | `false` | `false` | âœ… |

The token is derived deterministically per account: two SHA-256 digests of the
account id (base64url), concatenated, sliced to 84 chars behind the `P1gA`
prefix. `machineType`/`machineCode` are SHA-256 hex slices of the account id
with `:type`/`:code` suffixes. Same account â†’ same identity (like a seed
replay); different accounts â†’ different identities. No subprocess, no WSL, no
registry/device reads.

Example generated identity (matches the live WSL flow):

```json
{
  "machineToken": "P1gAlQyxNqOX6NeFicw5AjGBOgAd89oat7r_181tdQpSpY8XZ8uzbUsWB8NXMF9b_pjRxQWtB2uujdMz4g3zdEVu",
  "machineType": "0acb10c0190c1d5c9d",
  "machineCode": "59022bad8fae0f54b2",
  "vmInfo": { "isVm": false, "brand": "None", "percentage": 0, "vmTypeCode": 91 }
}
```

Later same-account controls found that this generated identity, an empty
identity, random bytes, and omitted machine headers all expose the campaign
for an account that already has a grant. The campaign does not validate UMID
authenticity. Generated identity remains an opt-in implementation choice, but
it is not disqualified from daily claims; it also cannot create a missing
grant. See [the corrected controls and limits](2026-10-30-qoder-umid-and-identity-findings.md).

## Results (final)

53 accounts â†’ **31 claimed +100** (3100 credits), 22 no-grant.

Claimed (31): Saye nak unben Pliss, Dimas Kontak, Calvion, kawa kawa, Sunny
Koding, Tokio Carlotta, Suni Kontak, Jinxi, Risun Drive, Borneo usar, Sunta
Borneo, Mamandy Remix, anjir bayam, Risun Phoebe, Irwati Saputra, Bolu Putra,
Baiji Mawaif, Yinlora, papa mama, Encrionku, Baizethku, Dimas Rizki, Dinda
Terua, Verinel, anjir1 23, Dinda fariska, Risky Hamzah, The HertaBorneo,
Risun Bisnis, Risun Hared, Dimas Gurutopia.

No-grant (22): DMAZRH GT, Lanjar Binsahab, Endang Pattipeilohy, Lukman
Susanto, Rafael Sudiati, Teguh Sihotang, Emil Wenas, Ne Snae, Mappanyukki
Lengkong, Cherley Darojat, Vinsen Nasyidah, Safira Ratulangi, Suhardi
Damanik, Mahfud Kallay, La Puspita, Ana Bancin, Bella Bay, Mario Halim, Edi
Putrayasa, Nawang Maulana, Alma Agutah, 15220795 DIMAS RIZKI HAMZAH.

## Tooling (`C:/Users/Aria/AppData/Local/Temp/opencode/`)

| Script | Purpose |
|---|---|
| `qoder-lib.ts` | shared lib: json load/save, mint, refresh+persist, headers, probe, claim, classify |
| `qoder-runner.ts` | single + hunter (probe 5s until CLAIMABLE) per account |
| `qoder-sweep.ts` | batch sweep, rotate proxy |
| `qoder-loop5.ts` | 5-account batches, 20s batch gap, 6min pass gap |
| `qoder-fast-sweep.ts` | fast sweep (8 parallel, 3Ã—3s retry) |
| `qoder-reward-probe.ts` | `/reward` probe for no-grant accounts |
| `qoder-dump-alma.ts` | raw campaign dump for a specific account |
| `qoder-stamp-confirmed.ts` | stamp `lastClaimAt` for verified claims |

## Operational notes

- PowerShell mangles inline `$` â€” write commands to `.ps1` / `.ts` files.
- WSL bridge: `wsl -e bash -lc "<script>"`; ELF path in WSL is
  `/mnt/d/â€¦/runtime-info`.
- Serialize seed wiping across workers (concurrent wipes â†’ duplicate identities).
- Always re-mint + re-refresh per attempt; stale state fails.
- Account JSON is the source of truth: `saveDoc` after every refresh; set
  `lastClaimAt` only on success / SAME_PERSON.

## Open questions

- Can the 20 GSuite no-grant accounts be activated (e.g., one official-client
  login/upgrade) before the grant appears? Untested.
- Precise open/close window period (estimated ~5â€“8 min between bursts).
- Whether the program resets daily (campaign `act-20261027-489` is valid
  30 days, not obviously daily).
- Whether `VIEW_DETAILS` promos flip to `CLAIM_BENEFIT` when their conditions
  (community goal / subscribe) are met.
