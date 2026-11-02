# Buddy device identity: Turing token + per-account binding

Buddy-family providers (`cb`, `cbcn`, `workbuddy`, `workbuddycn`) carry two
device-identity headers on desktop chat traffic:

- `X-Device-Token` — the TuringShield risk token (real device fingerprint,
  encrypted).
- `X-Device-Id-List: {"qimei36":"…"}` — a per-account device binding.

Together they tell upstream risk control which device is talking. The first is
machine-bound; the second is what makes each pooled account look like its own
device.

## Turing SDK (bundled)

The SDK is a proprietary native binary shipped under `vendor/turing-sdk/`
(WorkBuddy desktop 5.8.4 extract: `turing_sdk.node`, `TuringShieldSDK.dll`,
variant json). It is loaded at runtime; no env is required.
`CARTETHYIA_TURING_SDK_PATH` overrides the bundle for deployments that bring
their own copy.

Pipeline (from the vendor DLL and reverse notes):
device fingerprint → JCE V3 → XXTEA → AES-256-CBC (+embedded RSA) → base64
`v3:AAAA…`. The token is produced by `configure(channelId, productName,
productVersion)` + `fetchDeviceToken({…})`.

Per-provider payload profiles (same SDK, distinct product identity — tokens
differ between providers):

| Provider | channelId | productName | productVersion |
|---|---|---|
| WorkBuddy | 400111 | WorkBuddy AI | 5.8.4 |
| CodeBuddy | 400111 | CodeBuddy | 4.12.1 |

The desktop contract is **token || error**, never neither: if the SDK cannot
produce a token, `X-Device-Token-Error: sdk_not_initialized` is sent. A
captured token from `auth_state.deviceToken` / `CARTETHYIA_DEVICE_TOKEN_FILE`
is used only when the SDK is absent.

## Per-account binding (`qimei36`)

The desktop client also sends `X-Device-Id-List: {"qimei36":"…"}` — a second,
independent device identity. Resolving it per account gives each account in a
pool its own device presentation instead of sharing the machine's single
fingerprint:

1. `auth_state.qimei36` — explicit binding (operator-set / imported) wins.
2. Otherwise a deterministic sha256 of the account id (32 hex). Stable across
   restarts, no database write, and each freshly added account gets its own id
   automatically.

Returned only when an account id is available (unauthenticated sends none).

## Where it lives

| Concern | File |
|---|---|
| Turing SDK loader + service (token generation, cache, fallback) | `src/providers/integrations/buddy/turing-device-token.ts` |
| Per-account binding resolution (`resolveBuddyDeviceBinding`) | `src/providers/integrations/buddy/buddy-identity.ts` |
| Device-token header pair | `src/providers/integrations/buddy/workbuddy/shared.ts` |
| WorkBuddy headers (incl. `X-Device-Id-List`) | `src/providers/integrations/buddy/workbuddy/shared.ts` |
| CodeBuddy headers (incl. `X-Device-Id-List`) | `src/providers/integrations/buddy/codebuddy/shared.ts` |
| Vendored SDK | `vendor/turing-sdk/` |
| Reverse notes (archived) | [2026-10-28-turing-x-device-token-reverse.md](2026-10-28-turing-x-device-token-reverse.md) |

## Known limitation

`X-Device-Token` remains one per machine (the SDK derives it from hardware; it
does not accept per-account input). The per-account `qimei36` binding is what
distinguishes accounts. A second, full per-account Turing token would require
reimplementing the proprietary crypto — not done.
