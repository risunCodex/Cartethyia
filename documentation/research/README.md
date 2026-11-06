# ﻿# Archived research

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


| Folder      | Topic                                                                                                                                                      | Notes      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `qoder/`    | Qoder research (root: audit statis artifact + COSY signing; `live/`: wire reference, payload limits, model matrix, tool-calling, credits — hasil nyata) | 10 files   |
| `copilot/`  | Copilot capability/context/auto routing                                                                                                                    | 4 findings |
| `kiro/`     | Kiro 1.4.62 wire protocol + live verification + IDE/CLI unpack                                                                                             | 3 files    |
| `opencode/` | OpenCode free-tier wire/gate/sentinel + egress/TLS measurements (merged), desktop 2.2.5 binary evidence                                                    | 2 files    |
| `buddy/`    | Buddy family (CodeBuddy intl/CN + WorkBuddy desktop) — chat dispatch headers, device identity, CLI 2.179.2 + desktop app.asar unpack audits, 1:1 wire gaps | 6 files    |
| `cursor/`   | Cursor Run protocol + entitlement                                                                                                                          | 1 file     |
| `grok/`     | Grok Build CLI 1.0.70 binary unpack — endpoint, headers, payload, quota                                                                                    | 1 file     |
| `trae/`     | Trae IDE 3.6.13 unpack — endpoint inventory (chat/agent/commercial), auth headers, wire verification vs adapter                                            | 2 files   |


## Root notes


| Date       | Topic    | Note                                                                                |
| ---------- | -------- | ----------------------------------------------------------------------------------- |
| 2026-10-23 | Routing  | [Request-path census](2026-10-23-routing-request-path-census.md)                    |
| 2026-10-23 | Routing  | [Layered caching proposal](2026-10-23-routing-layered-caching-proposal.md)          |
| 2026-10-23 | Trae     | [Agent vs. chat surface](2026-10-23-trae-agent-vs-chat-surface.md)                  |
| 2026-10-30 | Database | [Share-child row optimization](2026-10-30-database-share-child-row-optimization.md) |
| 2026-11-06 | Trae     | [3.6.13 unpack + wire audit](trae/2026-11-06-trae-3.6.13-unpack-wire-audit.md)     |


## Qoder findings (`qoder/`)

### Live — hasil nyata (`qoder/live/`)

| Date       | Note                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------- |
| 2026-11-05 | [Wire Reference &amp; Adapter Alignment](qoder/live/2026-11-05-qoder-wire-reference-adapter-alignment.md) — header per permukaan + live capture (CLI/IDE/gRPC/OAuth) + delta audit |
| 2026-11-05 | [Payload Limits per Surface](qoder/live/2026-11-05-qoder-payload-limits.md) — HTTP ~256K, gRPC ~5.5M–6M |
| 2026-11-05 | [Model Matrix &amp; Roster Metadata](qoder/live/2026-11-05-qoder-model-matrix.md) — 150/150 pass + roster raw_usage |
| 2026-11-05 | [Tool-Calling: Probe, Postmortem &amp; Matrix](qoder/live/2026-11-05-qoder-tool-calling.md) |
| 2026-11-05 | [Credits, claims &amp; identity (incl. 1 Nov deep-dive)](qoder/live/2026-11-05-qoder-credits-claims-identity.md) |

### Research — audit statis (root)

| Date       | Note                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------- |
| 2026-11-05 | [COSY Signing &amp; Machine Identity](qoder/2026-11-05-qoder-cosy-signing-machine-identity.md) |
| 2026-11-05 | [Audit — IDE 1.38](qoder/2026-11-05-qoder-ide-1.38-audit.md) |
| 2026-11-05 | [Audit — CLI 1.1.83](qoder/2026-11-05-qoder-cli-windows-1.1.83-audit.md) |
| 2026-11-05 | [Audit — NSIS 0.5.3](qoder/2026-11-05-qoder-win-nsis-0.5.3-audit.md) |


## Copilot findings (`copilot/`)


| Date       | Note                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------- |
| 2026-10-15 | [Capability map](copilot/2026-10-15-copilot-chat-capability-map.md)                                               |
| 2026-10-16 | [Chat context and live API probe](copilot/2026-10-16-copilot-context-probe.md)                                    |
| 2026-10-30 | [Auto routing](copilot/2026-10-30-copilot-auto-routing.md)                                                        |
| 2026-11-02 | [Auto → Responses 500: tool-argument repair throw](copilot/2026-11-02-copilot-auto-responses-500-repair-throw.md) |


## Kiro findings (`kiro/`)


| Date       | Note                                                                         |
| ---------- | ---------------------------------------------------------------------------- |
| 2026-11-01 | [Wire protocol reconstruction (bundle)](kiro/kiro-wire-protocol.md)          |
| 2026-11-02 | [Live wire verification (probes)](kiro/2026-11-02-kiro-wire-verification.md) |
| 2026-11-02 | [IDE/CLI unpack evidence](kiro/2026-11-02-kiro-ide-cli-protocol.md)          |


## OpenCode findings (`opencode/`)


| Date       | Note                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------- |
| 2026-11-02 | [Free-tier wire, gate &amp; sentinel (merged reference)](opencode/2026-11-02-opencode-free-tier.md) |
| 2026-11-02 | [Desktop 2.2.5 binary evidence + replay](opencode/2026-11-02-desktop-2.2.5-binary-evidence.md)      |


## Buddy findings (`buddy/`)


| Date       | Note                                                                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-19 | [Chat dispatch headers: required headers, errors, tier](buddy/2026-10-19-codebuddy-chat-dispatch-headers.md)                           |
| 2026-10-28 | [TuringShield x-device-token reverse notes (archived — untrusted)](buddy/2026-10-28-turing-x-device-token-reverse.md)                  |
| 2026-10-30 | [Buddy device identity: Turing token + per-account binding](buddy/2026-10-30-buddy-device-binding.md)                                  |
| 2026-11-02 | [CLI 2.179.2 unpack wire audit — headers + payload builders](buddy/2026-11-02-codebuddy-cli-2.179.2-unpack-wire-audit.md)              |
| 2026-11-02 | [Desktop Electron app.asar unpack — chat wire, auth-state headers, queue API](buddy/2026-11-02-workbuddy-desktop-unpack-wire-audit.md) |
| 2026-11-02 | [1:1 wire gap list (CLI mirror)](buddy/2026-11-02-buddy-1-1-wire-gaps.md)                                                              |


## Cursor findings (`cursor/`)


| Date       | Note                                                                            |
| ---------- | ------------------------------------------------------------------------------- |
| 2026-10-20 | [Run protocol + entitlement evidence](cursor/2026-10-20-cursor-run-protocol.md) |


## Grok findings (`grok/`)


| Date       | Note                                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| 2026-11-02 | [Grok Build CLI 1.0.70 binary unpack — endpoint, headers, payload, quota](grok/2026-11-02-grok-build-1.0.70-unpack.md) |


## Trae findings (`trae/`)


| Date       | Note                                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| 2026-11-06 | [IDE 3.6.13 unpack + wire audit](trae/2026-11-06-trae-3.6.13-unpack-wire-audit.md) — endpoint inventory (chat/agent/commercial), auth headers, live wire verification vs adapter |
| 2026-11-06 | [Header & payload builder audit](trae/2026-11-06-trae-header-payload-builder-audit.md) — harness header inventory, gap audit vs `buildTraeHeaders` (24 gaps), payload shapes |
