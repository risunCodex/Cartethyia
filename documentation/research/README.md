# Archived research

Notes use one global sequence, ordered by the date of the documented event or
observation. Dates use `YYYY-MM-DD`. When an older note has no explicit
observation date, its recorded archive date is used. Notes about the same
investigation stay adjacent; separate evidence and implementation records stay
separate when their scopes differ.

When findings overlap, use the latest verified controls as the current
conclusion. Older measurements remain historical evidence and should not
override newer findings. In particular, see the Qoder identity follow-up and
the current Copilot Auto probe.

## Organization

Topics with many findings live in subfolders (`qoder/`, `copilot/`); single
or foundational notes stay at this root.

## Subfolders

| Folder | Topic | Notes |
|---|---|---|
| `qoder/` | Qoder wire, identity, credits, IDE surface, plugin endpoint map | 3 findings |
| `copilot/` | Copilot capability/context/auto routing | 3 findings |
| `kiro/` | Kiro 1.4.62 wire protocol + live verification + IDE/CLI unpack | 3 files |
| `opencode/` | OpenCode free-tier wire/gate/sentinel + egress/TLS measurements (merged), desktop 2.2.5 binary evidence | 2 files |
| `codebuddy/` | CodeBuddy intl chat dispatch headers + Turing device identity/binding (incl. archived reverse note) | 3 files |
| `cursor/` | Cursor Run protocol + entitlement | 1 file |

## Root notes

| Date | Topic | Note |
|---|---|---|
| 2026-10-23 | Routing | [Request-path census](2026-10-23-routing-request-path-census.md) |
| 2026-10-23 | Routing | [Layered caching proposal](2026-10-23-routing-layered-caching-proposal.md) |
| 2026-10-23 | Trae | [Agent vs. chat surface](2026-10-23-trae-agent-vs-chat-surface.md) |
| 2026-10-30 | Security | [Share-link minting abuse incident](2026-10-30-security-share-link-minting-abuse.md) |
| 2026-10-30 | Database | [Share-child row optimization](2026-10-30-database-share-child-row-optimization.md) |

## Qoder findings (`qoder/`)

| Date | Note |
|---|---|
| 2026-10-29 | [Credits, claims & identity (incl. 1 Nov deep-dive)](qoder/2026-10-29-qoder-credits-claims-identity.md) |
| 2026-11-01 | [Chat wire verification (plugin + IDE surface)](qoder/2026-11-01-qoder-chat-wire-verification.md) |
| 2026-11-01 | [JetBrains plugin endpoint & service map](qoder/2026-11-01-qoder-jetbrains-plugin-endpoint-map.md) |

## Copilot findings (`copilot/`)

| Date | Note |
|---|---|
| 2026-10-15 | [Capability map](copilot/2026-10-15-copilot-chat-capability-map.md) |
| 2026-10-16 | [Chat context and live API probe](copilot/2026-10-16-copilot-context-probe.md) |
| 2026-10-30 | [Auto routing](copilot/2026-10-30-copilot-auto-routing.md) |

## Kiro findings (`kiro/`)

| Date | Note |
|---|---|
| 2026-11-01 | [Wire protocol reconstruction (bundle)](kiro/kiro-wire-protocol.md) |
| 2026-11-02 | [Live wire verification (probes)](kiro/2026-11-02-kiro-wire-verification.md) |
| 2026-11-02 | [IDE/CLI unpack evidence](kiro/2026-11-02-kiro-ide-cli-protocol.md) |

## OpenCode findings (`opencode/`)

| Date | Note |
|---|---|
| 2026-11-02 | [Free-tier wire, gate & sentinel (merged reference)](opencode/2026-11-02-opencode-free-tier.md) |
| 2026-11-02 | [Desktop 2.2.5 binary evidence + replay](opencode/2026-11-02-desktop-2.2.5-binary-evidence.md) |

## CodeBuddy findings (`codebuddy/`)

| Date | Note |
|---|---|
| 2026-10-19 | [Chat dispatch headers: required headers, errors, tier](codebuddy/2026-10-19-codebuddy-chat-dispatch-headers.md) |
| 2026-10-28 | [TuringShield x-device-token reverse notes (archived — untrusted)](codebuddy/2026-10-28-turing-x-device-token-reverse.md) |
| 2026-10-30 | [Buddy device identity: Turing token + per-account binding](codebuddy/2026-10-30-buddy-device-binding.md) |

## Cursor findings (`cursor/`)

| Date | Note |
|---|---|
| 2026-10-20 | [Run protocol + entitlement evidence](cursor/2026-10-20-cursor-run-protocol.md) |
