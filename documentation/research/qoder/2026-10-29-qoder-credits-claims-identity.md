# Qoder credits, claim system & device identity (2026-10-29 → 2026-11-01)

Merged research note covering the Qoder daily CREDITS campaign, the activity-claim
system behind credits and the welcome trial, and the UMID/device-identity
question. Endpoint behavior can drift; this records what was observed, the
recipe that worked, and the dead ends.

---

## Part A — Daily credit campaign (`act-20261027-489`)

Raw reverse-engineering notes from live probing of the Qoder production gateway
on 2026-10-29. The [UMID and identity section](#part-c--umid--device-identity)
corrects the original assumption: machine identity is not a gate for the daily
CREDITS campaign. The Buddy/Turing device-token investigation is a separate
provider and protocol.

### A.1 Objective

Claim the daily 100-credit campaign (`act-20261027-489`) for as many accounts
as possible from an exported account file, using uniquely minted device
identities per account. Constraints: proxy per account preferred but not
mandatory; two accounts kept as reserve (`Alma Agutah`, `Dimas Gurutopia`);
live per-account output, no silent/blocked runs; credentials only — no client,
no device-unlock theories; refresh token and device unique per attempt.

### A.2 Endpoints (base `https://openapi.qoder.sh`)

| Endpoint | Method | Use |
|---|---|---|
| `/api/v1/deviceToken/refresh` | POST | `drt-` → `dt-`; body `{refresh_token, machine_id, machine_token}` |
| `/sash/api/v1/me/campaigns` | GET | campaign list (desktop identity headers required) |
| `/sash/api/v1/me/campaigns/{id}/claim` | POST | claim (`{}`) |
| `/sash/api/v1/me/campaigns/{id}/reward` | GET | grant probe; `404 GRANT_NOT_FOUND` = no grant |

### A.3 Recipe that worked

1. **Fresh mint:** `rm -f /home/risun/.config/.locale_cfg` then
   `runtime-info 3` → fresh `{machineToken, machineType, machineCode}`. Token
   starts `P1gA…`. The `env` arg (0,3,4,5,6,7) is NOT a slot — same token per
   platform. Restoring a seed replays the identical token (proven T1==T3==T4).
2. **Headers:** `User-Agent: Qoder`, `Cosy-ClientType: 10`,
   `Cosy-Version: 1.1.64`, `cosy-machineid`/`cosy-machinetoken` (= UMID token),
   `cosy-machinetype`, `cosy-machinecode`, `cosy-machineos: x86_64_linux`,
   `cosy-machinehostname`.
3. **Refresh:** `POST /api/v1/deviceToken/refresh` with
   `{refresh_token, machine_id: authState.machineId, machine_token}`. Response
   rotates both `device_token` (`dt-…`) and `refresh_token` (`drt-…`) — **both
   must be written back to the account JSON**.
4. **Probe:** `GET /sash/api/v1/me/campaigns`; the CREDITS campaign has
   `actionType === "CLAIM_BENEFIT"` / `benefit.kind === "CREDITS"`.
5. **Claim:** when `claimStatus === "CLAIMABLE"`, `POST .../claim` with `{}`.
6. **Result mapping:**
   - `success !== false` + `status ∈ {CLAIMED, GRANTED, SUCCESS}` → success
     (+100, ALL_MODELS, 30 days).
   - `failureCode === "SAME_PERSON_ALREADY_CLAIMED"` / `status === "BLOCKED"`
     → already claimed / blocked.
   - HTTP 409 / `ALREADY_CLAIMED` / `REPLAYED` → already claimed (idempotent).

### A.4 Findings

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

   Both report `claimStatus=CLAIMABLE` but carry no `benefit` — they are info
   banners (`qoder.com/community-boost`, `qoder.com/pricing`).

4. **Account type is not a predictor.** Non-GSuite accounts are mixed:
   `Dimas Gurutopia` (non-GSuite) claimed successfully; `DMAZRH GT`
   (non-GSuite) has no grant. No uid-prefix or createdAt pattern separates
   eligible from not (checked prefixes `019c…`, `019e…`, `019f…`, `01a1…`;
   claimed createdAt spans 10-27..10-28, others 10-28..10-29 — overlapping).

5. **Proxy vs direct.** Proxies help with per-IP throttle (same account+proxy
   that failed succeeded minutes later), but don't affect eligibility — no-grant
   accounts fail on every proxy and on direct.

6. **Throttle is temporal, bursty.** After a run of successful claims, further
   attempts return `NO_CREDITS` (list hides the entry) until a pause. Observed
   inter-burst gaps ~2.7 min and ~6.4 min.

### A.5 Generated identity (no WSL, no registry touch)

To avoid executing the bridge binary / touching WSL or the real registry, a
**software-generated identity** mode is implemented in Cartethyia
(`src/providers/integrations/qoder/qoder-umid.ts`), gated by
`CARTETHYIA_QODER_UMID_GENERATED=true`. It mirrors the real bridge's output
shape (verified against a live WSL ELF mint): `machineToken` = `P1gA` + 84
base64url (88 total), `machineType`/`machineCode` = 18 hex each, `isVm` =
`false`. The token is derived deterministically per account: two SHA-256
digests of the account id (base64url), concatenated, sliced to 84 chars behind
the `P1gA` prefix. Same account → same identity (like a seed replay);
different accounts → different identities. No subprocess, no WSL, no
registry/device reads.

Later same-account controls found that this generated identity, an empty
identity, random bytes, and omitted machine headers all expose the campaign for
an account that already has a grant. The campaign does not validate UMID
authenticity. Generated identity remains an opt-in implementation choice, but
it is not disqualified from daily claims; it also cannot create a missing
grant (see [Part C](#part-c--umid--device-identity)).

### A.6 Results (final)

53 accounts → **31 claimed +100** (3100 credits), 22 no-grant. Claimed
includes `Dimas Gurutopia`, `Calvion`, `Jinxi`, `Risun Drive`, `Dimas Rizki`,
`Sunny Koding`, and others. No-grant (22) includes `DMAZRH GT`, `Alma
Agutah`, `Lanjar Binsahab`, `Endang Pattipeilohy`, and others.

### A.7 Operational notes

- PowerShell mangles inline `$` — write commands to `.ps1` / `.ts` files.
- WSL bridge: `wsl -e bash -lc "<script>"`; ELF path in WSL is
  `/mnt/d/…/runtime-info`.
- Serialize seed wiping across workers (concurrent wipes → duplicate identities).
- Always re-mint + re-refresh per attempt; stale state fails.
- Account JSON is the source of truth: `saveDoc` after every refresh; set
  `lastClaimAt` only on success / SAME_PERSON.

### A.8 Open questions

- Can the 20 GSuite no-grant accounts be activated before the grant appears? NO, ITS NEVER GRANTED.
- Precise open/close window period (estimated ~5–8 min between bursts).
- Whether the program resets daily (campaign `act-20261027-489` is valid 30 days, not obviously daily).
- Whether `VIEW_DETAILS` promos flip to `CLAIM_BENEFIT` when their conditions are met.

---

## Part B — Activity-claim system (welcome trial + credits)

Findings from reversing `qoder-ide` (Linux deb, 1.37.0-1793017296) after the
`pro-upgrade/*` paths were shown to be dead (404 regardless of identity).

### B.1 Endpoints

The unpacked workbench (`out/vs/workbench/workbench.desktop.main.js`) exposes an
activity-claim API the vendor never documented, separate from the
`/sash/api/v1/me/campaigns` surface used by the daily 100:

```js
Ldn = { USER_STATUS, DATA_POLICY, LOGOUT, USER_PLAN, CREDIT_USAGE, EXPERTS_ENABLE }
HM0 = { ACTIVITY: "/algo/api/v2/activity" }                       // Inference host (api2.qoder.sh)
Rqn = {
  CLAIM_ELIGIBILITY: "/api/v2/activity/claim/eligibility",        // openapi host
  CLAIM: "/api/v2/activity/claim",                                // openapi host
  QUOTA_RESET_LATEST: "/api/v2/activity/quota/reset/latest",      // openapi host
}
mQo = { CAMPAIGNS: "/sash/api/v1/me/campaigns" }                  // daily 100 surface
```

Client flow (`QoderAuthService`):

1. `GET {Inference}/algo/api/v2/activity` → `{code:0, data:{activities:[…]}}`
   — each activity carries an `activityId`.
2. `GET {OpenApi}/api/v2/activity/claim/eligibility` → `{code:0, data:[…]}`.
3. `POST {OpenApi}/api/v2/activity/claim?activityId=<id>` → `code:0` claimed.

`claimActivity` is invoked from the credits UI only for items that appear in
**both** the activity list (eligibility intersect) — the UI never invents ids.
Literal ids found in the bundle include dev previews
(`developer-console-claim-preview`, `developer-console-reset-preview`,
`developer-preview`); real rewards are referenced by id from the activity list
response, i.e. **server-provisioned**, not client-enumerable.

### B.2 Signature schemes (in `out/vs/code/electron-utility/sharedProcess/sharedProcessMain.js`)

Three distinct schemes; verified empirically against `api2.qoder.sh`:

1. **COSY Bearer (RSA/AES md5 chain)** — already implemented in Cartethyia
   (`qoderSignerFor`). Confirmed working on `/algo/api/v2/activity`. Gotcha:
   for a GET the signer must sign the **empty string** (`""`), not a scrambled
   `"{}"` body — signing `{}` while sending no body still 403s, and POSTing the
   scrambled body is rejected (`POST not supported`).
2. **Gateway HMAC "Signature" scheme** (`s8` + `addSignatureHeaders`):
   ```txt
   secret   = sha256("cosy:" + ideVersion + ":" + machineToken)   // hex
   bodyHash = sha256(String(contentLength))                       // of the LENGTH string!
   sts      = `${method} ${path} ${requestId} ${machineToken} ${ts} ${bodyHash}`
   sig      = HMAC-SHA256(secret, sts)                            // hex
   ```
   Headers: `X-Request-Id`, `X-Client-Timestamp`, `Authorization: Signature <sig>`,
   `X-IDE-Platform`, `X-Version`, `X-Machine-OS`, `X-Machine-Id`; `path` has the
   leading `/algo` stripped for signing; `requestId` is a fresh UUID. Custom
   headers (incl. `Authorization: Bearer dt-…`) are merged **after**, overriding
   `Authorization`. The Alaun salted telemetry variant (`salt=apm`) hashes
   `path:version:machineToken` instead.
3. **Go static headers** (`qoderStaticHeaders`): `appcode`, `date`,
   `signature = md5("cosy&<b64secret>&<date>")` — already exported/proven in
   Cartethyia.

Region config lives at `GET https://center.qoder.sh/algo/api/v2/service/region/endpoints`
→ `inferNodes: ["https://api2.qoder.sh"]`, `openapiNodes: ["https://center.qoder.sh"]`.

### B.3 Live results (30 Oct 2026)

All four locally exported accounts (Akun Ytprem, jdm fullkeknya, minted
solegit, that sepa) — tokens + desktop identity:

| Check | Result |
| --- | --- |
| `GET /api/v2/activity/claim/eligibility` | 200 `{"code":0,"msg":"ok","data":[]}` (all) |
| `GET /algo/api/v2/activity` (COSY, body="") | 200 `{"code":0,"msg":"ok","data":{"activities":[],"queryAt":…}}` (all) |
| `GET /api/v2/activity/quota/reset/latest` | 200 `{"code":0,"msg":"ok"}` |
| `POST /api/v2/activity/claim?activityId=…` | not attempted — no eligible activity ids to claim |

Interpretation: the endpoints are live and callable with our existing signer,
but **no activity is provisioned for these accounts**. The welcome "2-week Pro
trial + 300 credits" is almost certainly seeded as an activity server-side for
eligible cohorts, and the client merely reveals it.

### B.4 Provision matrix — every identity path tested (30 Oct 2026)

A fresh registration ("why sould", registered 30 Oct via browser, welcome-email
cohort) was driven through **every identity path the API exposes**; none
provisioned activities, eligibility, daily credits, or the trial:

| # | Path | Machine identity | Interaction | Result |
| --- | --- | --- | --- | --- |
| 1 | PAT → `jobToken/exchange` → chat dispatch | synthetic (PAT-hash) | 1 real turn ("hello", streamed via `agent_chat_generation`, usage 31 input tokens) | `activities []`, `eligibility []`, plan Free, quota `0 / isQuotaExceeded` |
| 2 | Native device login (`QoderOAuthClient` flow) | random UUID `machine_id` | already had #1 | unchanged — still nothing |
| 3 | Native device login with a **genuine umidpack ELF-minted** `machine_id` (`P1gA…`) | genuine SG mint | already had #1 | unchanged — still nothing |
| 4 | Same account, re-checked post-login | — | — | campaigns only `VIEW_DETAILS` banners (`act-20261021-273`, `act-20261020-944`, `benefit:null`); no `CLAIM_BENEFIT`; no trial; no 300 |

Reading: provisioning did not appear after (a) changing credential kind, (b)
changing machine identity, (c) a completed interaction, or (d) receiving the
welcome-cohort email. The desktop IDE's full bootstrap stream was not replayed,
so its causal role and any broader cohorting mechanism remain unknown.
Separately, later same-account controls found machine headers do not gate an
already-provisioned daily CREDITS campaign (see Part C).

Durable deliverables: `whysould-genuine` account file on the Windows desktop
carries a native `dt-…`, a genuine ELF identity + persisted seed — usable by the
daily-claim pipeline whenever the account's grant window opens.
`checkClaimEligibility`/`claimActivity` client stack and the provision matrix
settle the "is there a hidden endpoint" question definitively.

### B.5 What this closes / remains open

- Closes: "the trial endpoint doesn't exist in the client" — it exists; it is
  the activity-claim family above, not `pro-upgrade/*`.
- Still open: whether a server-provisioned trial activity actually appears for a
  fresh account after the promised "complete an interaction" — testable only on
  an account that is both (a) currently logged in on the desktop and (b) in the
  provisioned cohort. If it appears, the full claim is reproducible with
  `qoderSignerFor` + the three OpenApi GET/POSTs above.

---

## Part C — UMID & device identity

Follow-up to Part A. Combines the native identity reverse engineering with the
later same-account controls that corrected the original machine-token theory.

### C.1 Components identified

| Binary | Role | Identity source |
|---|---|---|
| `runtime-info.exe` (Windows PE, Rust host) | thin host: loads `sgsdk.dll`, calls `initUMID` → `getSecurityToken` (+ `setActiveAccount`), does VM scoring locally, prints JSON | **hardware-derived, one per machine, stateless** |
| `sgsdk.dll` (7.3 MB, **signed ALIBABA CHINA NETWORK TECHNOLOGY**) | Alibaba SecurityGuard SDK: the actual UMID/SG engine; dynamic API resolution, encrypted state | machine-bound |
| `runtime-info` (Linux ELF, same Rust host) | same host pattern for Linux; collector reads `/sys`, `/proc`, `dmidecode`, `hdparm`, `lshw` | **seed file** (`~/.config/.locale_cfg`) |

Key strings recovered from the ELF:

- Cookie/seed keys **hardcoded** in the binary (obfuscated table, `.` delimited):
  `yooVto7srhDgkOv6`, `FAvgcHncgkVhZ4vC`, timestamp key `bdb13dc551d3db53`.
- Endpoints: `https://umid.daily.alibaba.net/repPc.json` (+ pre-prod/alt hosts),
  query `%s?e=%d&pn=%s&os=%d&sv=%s&pv=%s&pt=%d`, version `1.5.0`.
- Collectors: `/sys/class/dmi/id/*` (board/bios/product/sys vendor),
  `/proc/cpuinfo` flags, `/sys/class/net/*/address` (MAC), `dmidecode -t 4`
  (CPU ID), `-t baseboard` (Serial No), `hdparm -i` (disk serial),
  `lshw -class disk`, `/proc/sys/kernel/random/uuid`, `/dev/zero`, `xxh64`.
- VM detection (ELF, host-side): DMI vendors, cgroup (`docker/lxc/containerd`),
  `/proc/cpuinfo` hypervisor flag, vboxguest/vmci/vmbus modules,
  `/sys/hypervisor/type` — with a *scored* verdict ("weak indicators", "strong
  single indicator").

### C.2 Experimental results

1. **Seed → token is deterministic and offline.** Same seed ⇔ same token
   (T1==T2==T4). One-byte seed change ⇔ different token (T3). Timestamp field
   does not affect the token (T5).
2. **Fresh random seeds produce valid-shaped tokens.** A brand-new seed with
   random keys and random base64-ish values yields a `P1gA`-prefixed, 88-char
   token (A/B tests). Seed farming offline works.
3. **The Windows exe ignores `~/.config/.locale_cfg`** (leaves it untouched).
4. **The Windows exe is stateless on disk** — no state file appears anywhere.
   Token is a pure function of the machine's hardware.
5. **`--account-stdin`/`setActiveAccount` does NOT derive per-account tokens**
   on Windows: the token stayed constant across accounts.
6. **The ELF equally ignores the account argument** — token follows the seed,
   not the account.

### C.3 Server-side verdicts (latest live probes)

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

### C.4 Architecture conclusion

- **Native identity generation:** technically solved via the vendor bridge.
  Windows PE is hardware-bound; ELF/Mach-O identity can be replayed from its
  seed. The ELF seed mechanism is useful when a stable native identity is
  needed by other surfaces.
- **Daily CREDITS claims:** do not require a genuine identity or per-account
  seed. Generated, empty, random, and omitted machine headers were accepted on
  already-granted accounts. Keep identity persistence for deterministic replay
  and other integrations, not as a campaign-grant prerequisite.
- Reimplementing seed→token in pure JS would require breaking the SG crypto
  (out of scope); running the ELF without WSL would require a bundled Linux
  runtime.

### C.5 Practical recipe

1. Check the account has a grant and a valid `dt-` token; `404
   GRANT_NOT_FOUND` means there is no grant to claim.
2. Read the campaign list and claim only an explicitly `CLAIMABLE` CREDITS
   entry.
3. Machine headers may be genuine, generated, empty, or omitted for the tested
   CREDITS surface; identity headers do not make an ungranted account eligible.
4. Persist rotated device and refresh tokens. Keep native seeds only when
   deterministic identity replay is needed for another surface.

---

## Part D — Live revalidation on 2026-11-01 (`Dimas Gurutopia`)

Re-ran the claim-family endpoints with the current OAuth account (`Dimas
Gurutopia`, `dt-…` device token, `drt-…` refresh) to confirm which findings still
hold.

| Check | Result |
| --- | --- |
| `GET /sash/api/v1/me/campaigns` (Bearer `dt-`) | 200 — **only the promo banner** `act-20261020-944` (`VIEW_DETAILS`, `claimStatus=CLAIMABLE`, no `benefit`); **no CREDITS campaign present** at probe time |
| `GET /algo/api/v2/activity` (COSY-signed, body="") | **500 Internal Server Error** — endpoint no longer answers 200 with `data.activities` for this account/headers (changed since Part B) |
| `GET /api/v2/activity/claim/eligibility` (Bearer `dt-`) | 200 `{"code":0,"data":[]}` — same empty-eligibility shape as Part B |
| `GET /api/v2/activity/claim/eligibility` (COSY-signed) | 401 `TOKEN_INVALID` — **the COSY Bearer scheme is not accepted on the openapi host**; plain bearer works |
| `GET /api/v2/activity/quota/reset/latest` (Bearer `dt-`) | 200 `{"code":0,"msg":"ok"}` |
| `GET /api/v2/activity/quota/reset/latest` (COSY-signed) | 401 `TOKEN_INVALID` |
| `GET /api/v2/quota/usage` (Bearer `dt-`) | 200 — `totalUsagePercentage:0.01`, `isQuotaExceeded:false`, `usageType:"credits"`, expiry info |

Conclusions from this pass:

- The daily CREDITS campaign is **not currently visible** for `Dimas
  Gurutopia` (list flutters per Part A.4; the 30-day `act-20261027-489` may
  have closed or be between windows). No claim was attempted because there was
  no `CLAIM_BENEFIT`/CREDITS entry to target.
- The activity-claim family on the **openapi host accepts a plain `Bearer dt-`
  token** (200). The COSY Bearer scheme maps to the `/algo`/inference host, not
  openapi (401). Part B's three-endpoint recipe should be read with this host
  split in mind.
- `GET /algo/api/v2/activity` changed behavior (was 200, now 500 for our
  signer/body). Treat as drifted; re-verify before relying on it.

---

## Part E — Deep-dive 2026-11-01: claim id, same-person, worker & VPS

Follow-up to Part D using the full live OAuth roster (133 active qoder
accounts on the VPS + local exports). This pass settled several open questions
from Part A and produced the production worker fix.

### E.1 Claim path uses `campaignId` (UUID), not `campaignKey`

The claim/reward endpoints take the **`campaignId` (UUID)**, not the
`campaignKey` (`act-…`). Using the key returns `400 FIELD_VALIDATION_FAILED`:

| Path | Result |
|---|---|
| `POST /sash/api/v1/me/campaigns/{campaignKey}/claim` | `400 {"errorCode":"FIELD_VALIDATION_FAILED"}` |
| `POST /sash/api/v1/me/campaigns/{campaignId}/claim` | `200` (claim / already-claimed / blocked) |
| `GET /sash/api/v1/me/campaigns/{campaignId}/reward` | `200` grant, or `404 GRANT_NOT_FOUND` |

Promo campaign `act-20261020-944` (id `01a159af-…`) **is claimable** — POSTing
`{}` returned `200 {"status":"CLAIMED","grantId":…}` even though it is a
`VIEW_DETAILS` banner with no `benefit`. It grants nothing credit-wise, so
claiming it is a waste, but the endpoint works for it.

### E.2 Native UMID headers unlock the CREDITS campaign

| Headers | Campaigns listed |
|---|---|
| Basic desktop headers (no machine headers) | promo `act-20261020-944` only |
| + `qoderMachineHeaders(identity)` (UMID) | **+ CREDITS `act-20261101-825`** when the account hasn't claimed it |

Observed on multiple accounts: without machine headers the CREDITS campaign was
absent; with the minted UMID headers it appeared as `CLAIM_BENEFIT`,
`CLAIMABLE`, `benefit.kind=CREDITS, amount=100, ALL_MODELS, 30 days`.

### E.3 "Same person" is per-account (uid) + per-campaign — IP/device do NOT matter

For the 8 accounts holding a 100-credit grant (quota `addOnQuota.total=100`),
a direct claim of the known ID campaign id returned:

| Account | Direct claim result |
|---|---|
| Sunny Koding | `200 CLAIMED` (`replayed:false`, grantId `01a196b7-…`) |
| Alma Agutah, Borneo usar, Dimas Kontak, Risun Drive, Sunta Borneo, Tokio Carlotta, Risun Phoebe | `200 BLOCKED` `failureCode=SAME_PERSON_ALREADY_CLAIMED` |

Causation cleared by varying every factor we could control:

- **IP**: same result direct, via rotating residential proxies
  (`*.proxy.rlwy.net`, 40 endpoints), and from the VPS datacenter IP.
- **Device identity**: same result with generated (isVm=false), random machine
  headers, and genuine umidpack runtime-info (isVm=true on the VPS).
- **machineId / machineToken / machineCode**: rotation changed nothing.

Interpretation: the same-person verdict is bound to the **uid** and the
**campaign**. An account that has claimed a credit campaign is permanently
blocked for that campaign; the server hides it from the list (which is why the
sweep's "no CREDITS campaign" reading is the *post-claim* state, not a bug).

### E.4 Quota is the ground truth for a successful claim

| Account | addOnQuota before | after |
|---|---|---|
| Sunny Koding | 100 | **200** (used 0) |
| Jinxi | 100 | **200** (used 3) |
| other 7 granted | 100 | 100 (unchanged — blocked) |

A successful daily claim takes the grant from 100 → 200. Remaining "100"
balances on blocked accounts are leftovers from earlier claims, not new claim
opportunities.

### E.5 Worker fix (`qoder-checkin.ts`)

Production worker changes (deployed to the VPS and verified):

1. `tryClaimDaily` only claims `CLAIMABLE` **CREDITS-kind** campaigns
   (`benefit.kind=CREDITS` or `actionType=CLAIM_BENEFIT`). Promo rows are no
   longer claimed — previously `VIEW_DETAILS` was claimed, producing a
   misleading `claimed` with 0 credits.
2. `already_claimed` is only reported when a **CREDITS-kind** campaign is
   `CLAIMED`. A claimed promo no longer short-circuits the day.
3. `probeDailyClaim` treats a `claimed`/`already_claimed` basic result as
   terminal (no redundant identity probing).

### E.6 VPS deployment notes

- The umidpack bridge was present under `vendor/qoder-umid/umidpack/` but the
  ELF binaries had no `+x` — `chmod +x` fixed `[qoder] elf mint failed`.
- On the VPS the ELF reports `isVm:true` (VMware, 83%) — VM scoring does not
  gate the CREDITS surface (consistent with Part C).
- The production chain was verified end-to-end on the VPS: credential resolved
  (`dt-…`, len 27) → native identity minted → `fetchQoderDailyCheckin` ran and
  honestly reported `unavailable` when the campaign was hidden.
- The quota sweep rides the daily check-in every 60s (`intervalMs: 60_000`) and
  already reserved Redis day slots (`cartethyia:daily-checkin:2026-11-01:*`)
  — the sweep was running the qoder check-in path, it just had nothing to claim
  for most accounts.
- Deployment detail: the systemd service opens the production SQLite at
  `~/.local/share/Cartethyia/data/cartethyia.sqlite` (state under `data/`);
  verification scripts had to set `CARTETHYIA_DATA_DIR=…/data` to read the same
  DB.

### E.7 Local force-claim result

Running the same claim flow from the local machine (home IP) claims Sunny Koding
+100 (quota 100 → 200, `claimedAt 2026-11-01T10:46:22Z`, grant ID
`01a196b7-afc8-7c79-be0c-e6e39adad444`). Jinxi also claimed +100 locally. The
successful day-claims came from the local/home IP; the VPS IP could not surface
the campaign (it was hidden for blocked accounts). For accounts that have not
claimed the current campaign, running from a home/residential IP is the working
path.

### E.8 Full-roster pass (141 accounts)

All local exports were merged into one file (7 source files → 141 unique
accounts, all OAuth, all with tokens, no duplicates). Quota scan:

- **16 accounts hold a 100+ grant** (`addOnQuota.total >= 100`).
- **125 accounts have no grant** (`total=0`).

Claim attempt on all 16 granted accounts (product UMID headers, local IP):

| State | Count | Accounts |
|---|---|---|
| `CLAIMED` (+100) | 3 | Sunny Koding, Jinxi, **Suni Kontak** |
| `CLAIMED` (already, list shows it) | 2 | Sunny Koding, Jinxi (+ prior) |
| `BLOCKED` same-person | 13 | Alma Agutah, Borneo usar, Dimas Kontak, Risun Drive, Sunta Borneo, Tokio Carlotta, Risun Phoebe, papa mama, Saye nak unben Pliss, Calvion, Verinel, The HertaBorneo, Dimas Gurutopia |

Final day total: **+300 credits** across 3 accounts (Sunny Koding, Jinxi,
Suni Kontak). The remaining 13 granted accounts are same-person blocked; the 125
no-grant accounts cannot create a grant. All claim opportunities for the active
campaign are exhausted for this roster.

Full **141-account** campaign-surface scan (native UMID headers, local IP):

| Surface | Count |
|---|---|
| `CLAIMED` CREDITS campaign visible | 3 (Jinxi, Sunny Koding, Suni Kontak) |
| Promo-only (`VIEW_DETAILS`, no credits) | 138 |
| No campaigns / other | 0 |

Every no-grant account and every blocked account surfaces only the promo
banner — no CREDITS campaign is provisioned for them. The roster is fully
exhausted for the active campaign.

## Evidence files

- Account exports (merged): `C:/Users/Aria/Desktop/qoder-accounts-2026-11-01-merged-all.json`
  (141 unique qoder accounts; the 7 per-file exports they replaced were deleted after merging)
- Original exports: `C:/Users/Aria/Desktop/qoder-accounts-2026-10-29T12-53-38-453Z.json`,
  `qoder-accounts-2026-10-29T15-37-01-530Z.json`
- UMID bridge: `vendor/qoder-umid/runtime-info` (Linux ELF), seed
  `/home/risun/.config/.locale_cfg`
- Official bundle: `D:/tmp/qodercli/npm-package/package/bundle/qoder-worker-runtime.mjs`
- Windows PE identity: `D:/tmp/qodercli/cli-state/.bin/umid-win32-x64-48d1294f147c9d89/`
- Probe tooling: `scripts/provider-probing/qoder/probe-qoder-credits.ts`
  (campaign list / reward / claim / activity family)
- Proxies: `http://{altaria,ballast,caboose,…}.proxy.rlwy.net:<port>` (40 endpoints)
