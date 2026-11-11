# Proposal — `src/network` restructure (clear grouping, clearer names, no barrel)

Status: **implemented 2026-11-11** — see the verification record at the bottom.
Scope: `src/network/**` plus every importer of it (backend only; dashboard untouched).
Goal: replace the flat mixed root with three purpose-named groups; merge siblings;
optionally split the `resolver.ts` monolith; remove the barrel.

---

## 1. What is wrong today (measured 2026-11-11)

The root currently holds **14 files** mixing four different concerns:

```
src/network/
├── pool/                        # good — already grouped
│   ├── agent.ts  loader.ts  selector.ts
│   ├── pool-state.ts  pool-scripts.ts  byte-accounting.ts
│   └── resolver.ts               # 1110 lines, 4 responsibilities
├── outbound-fetch.ts             # core egress (HTTP)
├── http2-bidi.ts                 # core egress (HTTP/2 bidi)
├── ssrf.ts                       # core egress (validation)
├── tls-profile.ts                # core egress (ClientHello mirror)
├── client.ts                     # core egress (facade)
├── pool-health.ts                # pool domain — LEAKED to root
├── pool-health-machine.ts        # pool domain — LEAKED to root
├── pool-cooldown-store.ts        # pool domain — LEAKED to root
├── types.ts                      # pool domain (AgentConfig/parseAgentConfig) — generic name
├── backoff.ts  retry.ts  deduplication.ts  ip-utils.ts  rate-limit-verdict.ts
│                                 # pure utilities — mixed with core
└── index.ts                      # barrel — hides the structure
```

Concrete complaints:

1. **Three pool-domain files live in the root** (`pool-health.ts`,
   `pool-health-machine.ts`, `pool-cooldown-store.ts`) while a `pool/` folder
   exists. They belong inside it.
2. **`types.ts` is a generic name** for what is actually pool agent config
   (`AgentConfig`, `parseAgentConfig`, `ProxyConfigError`). It is pool domain,
   not a shared type bag.
3. **Core egress has no home** — it is spread across 5 flat files with
   inconsistent verbs (`outbound-fetch`, `http2-bidi`, `ssrf`,
   `tls-profile`, `client`).
4. **Pure utilities sit next to core transport** (`backoff`, `retry`,
   `deduplication`, `ip-utils` are leaf modules with no repo-specific
   dependency; `rate-limit-verdict` is not pure — it imports
   `providers/provider-metadata`, so it belongs with egress, not utilities).
5. **`pool-health.ts` vs `pool-health-machine.ts`** — same domain, split by
   accident, and the names don't say what differs.
6. **Barrel `index.ts`** hides import graph; it was added in the recent
   egress work and has zero external importers. Remove it.
7. **`resolver.ts` (1110 lines)** hosts four distinct jobs: `PoolAgentResolver`
   (pool side), `ValidatedNetworkBindingFactory` (egress side), raw TLS dial
   helpers (`dialDirect`/`dialThroughPool`), and stream/session adapters
   (`openBidiStream`/`WsSession`).

---

## 2. Target structure

```
src/network/
├── egress/                     # dialing out: validated HTTP, bidi, TLS mirror, SSRF
│   ├── fetch.ts                # createValidatedFetch, relay, nodeDial, profile agent   (ex outbound-fetch.ts)
│   ├── bidi.ts                 # Http2Bidi contract types                              (ex http2-bidi.ts)
│   ├── dial.ts                 # dialDirect, dialThroughPool                           (from resolver.ts)
│   ├── factory.ts              # ValidatedNetworkBindingFactory (fetch/fetchWithTls/bidi/ws/resolve)  (from resolver.ts)
│   ├── bidi-session.ts         # Http2BidiSession, openBidiStream                      (from resolver.ts)
│   ├── ws.ts                   # WsSession, connectValidatedWebSocket                  (from resolver.ts)
│   ├── tls-profile.ts          # TLS ClientHello profiles                              (ex tls-profile.ts)
│   ├── verdict.ts              # EgressVerdict, classifyEgressFailure                  (ex rate-limit-verdict.ts)
│   └── ssrf.ts                 # resolve/validate/ssrf policy                         (ex ssrf.ts)
├── pool/                       # pool domain — everything pool, one home
│   ├── agent.ts                # agents (http/socks5/relay)
│   ├── loader.ts               # DrizzleNetworkPoolLoader
│   ├── selector.ts             # NetworkPoolSelector
│   ├── resolver.ts             # PoolAgentResolver only                                (slimmed from resolver.ts)
│   ├── state.ts                # (ex pool-state.ts)
│   ├── scripts.ts              # (ex pool-scripts.ts)
│   ├── accounting.ts           # (ex byte-accounting.ts)
│   ├── health.ts               # MERGE: pool-health.ts + pool-health-machine.ts
│   ├── cooldown-store.ts       # (ex pool-cooldown-store.ts)
│   └── agent-config.ts         # AgentConfig, parseAgentConfig, ProxyConfigError       (ex types.ts)
└── util/                       # leaf modules, no repo dependency
    ├── backoff.ts
    ├── retry.ts
    ├── dedupe.ts               # (ex deduplication.ts)
    └── ip.ts                   # (ex ip-utils.ts)
```

No `index.ts`. Every importer references the concrete file.

---

## 3. Mapping (old → new)

| Old | New | Notes |
| --- | --- | --- |
| `outbound-fetch.ts` | `egress/fetch.ts` | rename only; content unchanged |
| `http2-bidi.ts` | `egress/bidi.ts` | rename only; pure contract types |
| `ssrf.ts` | `egress/ssrf.ts` | rename only |
| `tls-profile.ts` | `egress/tls-profile.ts` | rename only |
| `client.ts` | `egress/factory.ts` facade? | kept as `egress/client.ts`? see §4 |
| `rate-limit-verdict.ts` | `egress/verdict.ts` | move with egress (imports provider metadata) |
| `pool-health.ts` + `pool-health-machine.ts` | `pool/health.ts` | merge (474 lines total) |
| `pool-cooldown-store.ts` | `pool/cooldown-store.ts` | move+rename |
| `types.ts` | `pool/agent-config.ts` | move+rename |
| `backoff.ts` | `util/backoff.ts` | move |
| `retry.ts` | `util/retry.ts` | move |
| `deduplication.ts` | `util/dedupe.ts` | move+rename |
| `ip-utils.ts` | `util/ip.ts` | move+rename |
| `pool-state.ts` | `pool/state.ts` | rename |
| `pool-scripts.ts` | `pool/scripts.ts` | rename |
| `byte-accounting.ts` | `pool/accounting.ts` | rename |
| `resolver.ts` | `pool/resolver.ts` + `egress/{dial,factory,bidi-session,ws}.ts` | split (see §5) |
| `index.ts` | — | delete |

External importer counts that must be rewritten (measured):

| File | Importers |
| --- | --- |
| `outbound-fetch.ts` | 20 |
| `http2-bidi.ts` | 5 |
| `ssrf.ts` | 4 |
| `pool-health.ts` | 11 |
| `pool-health-machine.ts` | 7 |
| `pool-cooldown-store.ts` | 3 |
| `rate-limit-verdict.ts` | 7 |
| `ip-utils.ts` | 4 |
| `backoff.ts` / `retry.ts` / `deduplication.ts` | 1 each |
| `tls-profile.ts` | 4 (new, internal + tests) |
| `types.ts` / `client.ts` | 0 external |

≈ 65 external import sites + internal cross-imports inside `network/`
(`outbound-fetch → ssrf`, `resolver → ssrf/http2-bidi/tls-profile/outbound-fetch`,
`pool-health* → selector/cooldown-store/rate-limit-verdict`, …).

---

## 4. Naming rules applied

- **Folder = purpose**: `egress/` (dialing out), `pool/` (pool domain),
  `util/` (pure leaves).
- **File = one responsibility**, snake_case, noun-y:
  `fetch` (HTTP), `bidi` (HTTP/2 stream), `dial` (raw TLS socket),
  `factory` (binding factory), `health` (health), `verdict` (failure class).
- **No barrel**: import the file. `src/network` consumers import e.g.
  `../network/egress/fetch` directly.
- **`client.ts`**: keep the facade as `egress/client.ts` (it *is* the client
  entry) or fold it into `egress/factory.ts`; proposal picks
  **`egress/client.ts`** to keep `createNetworkClient` discoverable.

---

## 5. Splitting `resolver.ts` (1110 → 6 files)

| Piece | Goes to | Depends on |
| --- | --- | --- |
| `PoolAgentResolver` | `pool/resolver.ts` | `pool/agent`, `pool/selector`, persistence |
| `ValidatedNetworkBindingFactory` | `egress/factory.ts` | `egress/fetch`, `egress/dial`, `egress/bidi-session`, `egress/ws`, `pool/resolver`, `ssrf` |
| `dialDirect`, `dialThroughPool` | `egress/dial.ts` | `pool/agent`, `egress/tls-profile`, `ssrf` |
| `openBidiStream`, `Http2BidiSession` | `egress/bidi-session.ts` | `egress/bidi` |
| `WsSession`, `connectValidatedWebSocket` | `egress/ws.ts` | `provider-contracts` (type) |

No cycle: `egress/*` may import `pool/*` types; `pool/resolver.ts` stays a
pure resolver (the factory owns the egress composition). The factory currently
lives in `pool/resolver.ts` only because the file grew; it is an egress
concern.

---

## 6. Migration & verification

1. **Mechanical**: `git mv` + one `sed` pass for import paths
   (`problems/network/<old>` → `../network/<group>/<new>`), then hand-fix the
   internal cross-imports inside `network/`.
2. **Typecheck** (`bun run typecheck`) — catches every missed rename.
3. **Backend suite** (`bun run test:backend`, currently 4805 pass) — behavior
   is untouched; all tests must stay green.
4. **Verification of the split**: run `test/network/**` + dispatch tests
   (`dispatch-consolidation`, `pool-egress-failover`, `pool-probe-enforcement`),
   which exercise the factory, bidi, and pool seams.

Cost shape: pure rename/move is risk-free except import rewrites; the
`resolver.ts` split is a structural change but each piece is a pure cut (no
logic edits), so typecheck + the network tests are the gate.

---

## 7. Alternatives considered

- **A (minimal)**: only move pool-domain files into `pool/` and rename
  `types.ts` → `pool/agent-config.ts`; keep core files flat, keep barrel but
  name it `network.ts`. Cheapest, but leaves the mixed core root and the
  1110-line resolver and the misnamed `http2-bidi`/`client`.
- **B (this proposal)**: full grouping + rename + merge `pool-health*` +
  split resolver + delete barrel. ~65 external import edits + internal ones;
  ~1 session.
- **C (aggressive)**: additionally split `selector.ts` (1110 lines) into
  `selector`/`cooldown`/`rotation` and split `pool/health.ts` further.
  Not proposed now — selector is cohesive and stable; health merge already
  gives one clear home.

Recommendation: **B**.

---

## 8. Implementation record (2026-11-11)

The proposal was executed as written, with two small deviations:

- `pool-health-machine.ts` merged into `pool/health.ts` (single file, both
  halves — flag helpers + state machine) instead of keeping a separate
  `health-machine.ts`; the merge is a pure concatenation with fixed imports,
  no logic changed.
- `client.ts` stayed `egress/client.ts` (see §4).

Resulting tree:

```
src/network/
├── egress/    bidi.ts  bidi-session.ts  client.ts  dial.ts  factory.ts
│              fetch.ts  ssrf.ts  tls-profile.ts  verdict.ts  ws.ts
├── pool/      accounting.ts  agent.ts  agent-config.ts  cooldown-store.ts
│              health.ts  loader.ts  resolver.ts  scripts.ts  selector.ts  state.ts
└── util/      backoff.ts  dedupe.ts  ip.ts  retry.ts
```

No `index.ts`. All importers updated (≈65 external sites + internal).

Verification (all green):

| Gate | Result |
| --- | --- |
| `bun run typecheck` | clean |
| `bun run test:backend` | 4805 pass / 1 skip / 0 fail |
| `bun run dashboard:test` | 699 pass / 0 fail |
| Legacy-path grep (`outbound-fetch`, `http2-bidi`, `ssrf`, `pool-health`, …) | zero hits |
