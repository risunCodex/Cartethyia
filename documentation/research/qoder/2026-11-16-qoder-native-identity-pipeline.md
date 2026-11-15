# Qoder native-identity pipeline + risk controls (2026-11-16)

Outcome of the cross-audit against the donor hub (`qoder2api-hub` v1.9.9) and
its issue #158: nine accounts across both realms pinned to
`10605 / queueType=p4 / RESOURCE_LIMIT` for 8+ hours with healthy quota — an
egress/machine-dimension risk signal, not a capacity queue.

## Why the identity source is the lever

The vendor bridge (`runtime-info[.exe]` + Windows `sgsdk.dll`) returns a
**machine-scoped** identity: byte-identical output for any/absent account on
one host (hub `_install_umid.py` ground truth, reproduced live 2026-11-16 —
`480,752 B` PE and `7,354,928 B` DLL carved from npm `@qoder-ai/qodercli`
1.1.89, sizes matching the hub's audit note verbatim). The upstream scores
that identity: a real bridge output is a first-party device; the OS-derived
mint is a shaped spoof; a full set of *derived* headers is actively filtered
from campaigns (donor issue #10) and shaped identities are the natural
suspect for the p4 pin (#158).

Cartethyia previously sent the OS-derived identity on chat and the real
desktop token only on the credits-claim path — two different "machines" for
one account.

## The pipeline now

Order of preference for every Qoder surface (chat COSY headers, auth,
check-in, credits claim):

1. **Bound native identity** — `provider_accounts.native_identity`
   (device binding is terminal once claimed; the account must not move
   devices).
2. **The vendor bridge** — `runtime-info` executed per realm (env code `0`
   CN / `3` intl desktop; the realms mint different tokens), majority-voted
   over 3 rounds against VM-verdict flapping, cached per realm in
   `machine_identity.json` (TTL 30 min, atomic 0600 writes — donor
   discipline).
3. **OS-derived mint** — fallback when the bridge is absent or disabled.

Components are extracted by `scripts/tools/qoder-umid-extract.mjs`
(npm tarball → sha512-verified → base64-literal scan of the worker bundle →
magic-byte identification, never positional). Identity flows to chat via
`resolveQoderAuth`/`attachQoderNativeIdentity` reading the realm cache; only
a `runtime-info`-sourced entry qualifies (a derived token must never ride the
chat identity).

Migration 0049 relaxes the `native_identity->>'machineToken'` unique index
(0026) to exclude `source = 'runtime-info'`: that token is machine-scoped, so
every account on one host legitimately binds the same value; derived/os
tokens stay one-per-account.

## Risk controls

- **`qoder-risk.ts` counters** — `queueTotal`, `p4Streak` per provider; the
  p4 warning re-alarms every `CARTETHYIA_QODER_P4_WARN_STREAK` (default 5)
  consecutive p4 envelopes and resets on a clean dispatch. One line per
  escalation, not per request.
- **`CARTETHYIA_QODER_MIN_GAP_MS`** (default 400, the hub's proven value) —
  same-account dispatches keep a minimum gap; the upstream scores request
  cadence as its own dimension (donor PR #78).
- The queued envelope error itself surfaces `queueType`/`subCode`
  (`[queueType=p4 subCode=RESOURCE_LIMIT]`) and string-bodied envelopes are
  parsed before classification (a raw JSON string body used to classify as
  `403 authentication_failed` instead of `upstream_queued`).

## What we deliberately did NOT copy from the hub

- **Cross-realm queue failover** — under a machine-level pin, both realms
  share the egress and the identity; failover burns 190 s for the same p4.
  Realms stay separate providers.
- **In-adapter wait×retry loop** (3 rounds × retryAfterSeconds) — the gateway
  is a sync proxy; fail-fast with `retryAfterMs` keeps the client in charge.
