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


| Folder      | Topic                                                                                                                                                      | Notes      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `qoder/`    | Qoder research — Desktop 0.5.12 unpack + native-identity pipeline at root; model matrix, COSY identity runs and Desktop 0.5.7 chat-surface evidence consolidated into `archive/`; earlier notes also in `archive/qoder-research-archive-2026-11-11.zip` | 3 files + `archive/` (5 notes + 1 zip) |
| `copilot/`  | Copilot capability/context/auto routing + wire audits                                                                                                       | 6 findings |
| `kiro/`     | Kiro 1.4.62 wire protocol + live verification + IDE/CLI unpack                                                                                             | 3 files    |
| `opencode/` | OpenCode free-tier wire/gate/sentinel + egress/TLS measurements (merged), desktop 2.2.5 binary evidence, vision handoff                                     | 3 files    |
| `buddy/`    | Buddy family (CodeBuddy intl/CN + WorkBuddy desktop) — chat dispatch headers, device identity, CLI 2.179.2 + desktop app.asar unpack audits, 1:1 wire gaps | 6 files    |
| `cursor/`   | Cursor Run protocol + entitlement + agent CLI 2026.11.05 wire audit (hosts, endpoint inventory, headers)                                                   | 2 files    |
| `grok/`     | Grok Build CLI 1.0.70 binary unpack — endpoint, headers, payload, quota                                                                                    | 1 file     |
| `trae/`     | Trae IDE 3.6.13 unpack — endpoint inventory (chat/agent/commercial), auth headers, wire verification vs adapter                                            | 2 files   |
| `deepai/`  | DeepAI Code 0.3.35 desktop unpack + wire audit — DeepAI sign-in (loopback exchange → api_key), API headers (Theos/machine/check-in), T3 Connect Clerk OAuth (PKCE/device grant), relay `/v1` control plane | 2 files   |
| `antigravity/` | Antigravity wire verification — live probes (2026-11-03)                                                                                                | 1 file     |
| `clixad/`   | Clixad wire — live verification ledger (2026-11-11)                                                                                                        | 1 file     |
| `devin/`    | Devin Desktop 3.11.238 audit, adapter proposals, image wire debug, live upstream verification (2026-11-06/07)                                              | 5 files    |


## Root notes


| Date       | Topic    | Note                                                                                |
| ---------- | -------- | ----------------------------------------------------------------------------------- |
| 2026-10-23 | Routing  | [Request-path census](../archive/2026-10-23-routing-request-path-census.md)         |
| 2026-10-23 | Routing  | [Layered caching proposal](../archive/2026-10-23-routing-layered-caching-proposal.md) |
| 2026-10-23 | Trae     | [Agent vs. chat surface](../archive/2026-10-23-trae-agent-vs-chat-surface.md)       |
| 2026-11-06 | Trae     | [3.6.13 unpack + wire audit](trae/2026-11-06-trae-3.6.13-unpack-wire-audit.md)     |
| 2026-11-06 | Cursor   | [agent CLI wire audit](cursor/2026-11-06-cursor-agent-cli-wire-audit.md) — hosts, endpoint inventory, header gap audit vs adapter (x-cursor-checksum gap, timezone/team-id), payloads |
| 2026-11-11 | DeepAI   | [Live wire verification](deepai/2026-11-11-deepai-code-live-wire-verification.md) — sign-in exchange, models (22), quota (Theos 50/day), chat hit non-stream + SSE |


## Qoder findings (`qoder/`)


| Date       | Note                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------- |
| 2026-11-05 | [Model Matrix &amp; Roster Metadata](qoder/archive/2026-11-05-qoder-model-matrix.md) — consolidated roster and metadata reference |
| 2026-11-11 | [All-models COSY identity run (19/19)](qoder/archive/2026-11-11-qoder-cosy-all-models-identity.md) |
| 2026-11-11 | [Identity distill (19/19, response self-claims)](qoder/archive/2026-11-11-qoder-identity-distill.md) |
| 2026-11-11 | [Desktop 0.5.7 — chat surface evidence (live)](qoder/archive/2026-11-11-qoder-desktop-0.5.7-chat-surface-evidence.md) |
| 2026-11-11 | [App 0.5.7 — Chat wire capture (worker, live)](qoder/archive/2026-11-11-qoder-worker-chat-wire-capture.md) |
| 2026-11-16 | [Desktop 0.5.12 — unpack evidence (Windows x64)](qoder/2026-11-16-qoder-desktop-0.5.12-unpack.md) — NSIS/electron-builder packaging change, two-layer 7z extract recipe, asar inventory |
| 2026-11-16 | [Native-identity pipeline + risk controls](qoder/2026-11-16-qoder-native-identity-pipeline.md) — machine-scoped vendor-bridge identity as the egress/machine risk lever, binding order, p4 pin (donor #158) |
| 2026-11-17 | [Worker core 1.1.86-hotfix.5 — live wire capture](qoder/2026-11-17-qoder-core-wire-capture-0.5.12.md) — mitmproxy capture of the spawned worker core (device-flow auth, PAT exchange), plus 0.5.12 unpack findings: env knobs and host tables |

Older Qoder notes (wire reference alignment, payload limits, tool-calling,
credits/claims, IDE/CLI/NSIS audits) were consolidated into
[archive/qoder-research-archive-2026-11-11.zip](qoder/archive/qoder-research-archive-2026-11-11.zip).


## Copilot findings (`copilot/`)


| Date       | Note                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------- |
| 2026-10-15 | [Capability map](copilot/2026-10-15-copilot-chat-capability-map.md)                                               |
| 2026-10-16 | [Chat context and live API probe](copilot/2026-10-16-copilot-context-probe.md)                                    |
| 2026-10-30 | [Auto routing](copilot/2026-10-30-copilot-auto-routing.md)                                                        |
| 2026-11-02 | [Auto → Responses 500: tool-argument repair throw](copilot/2026-11-02-copilot-auto-responses-500-repair-throw.md) |
| 2026-11-03 | [Wire audit — reference VS Code 1.144 vs adapter](copilot/2026-11-03-copilot-not-licensed-wire-audit.md)          |
| 2026-11-03 | [OpenCode vs Cartethyia — Copilot / Luna (Auto) wire](copilot/2026-11-03-opencode-copilot-comparison.md)          |


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
| 2026-11-02 | [Vision handoff on large CLI sessions](opencode/2026-11-02-vision-handoff-large-session.md)         |


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


## DeepAI findings (`deepai/`)


| Date       | Note                                                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-11-11 | [Desktop 0.3.35 unpack + wire audit](deepai/2026-11-11-deepai-code-desktop-0.3.35-unpack-wire-audit.md) — installer/layout, domains, DeepAI sign-in, T3 Connect Clerk OAuth, relay `/v1` control plane, provider integrations          |
| 2026-11-11 | [Live wire verification (probe)](deepai/2026-11-11-deepai-code-live-wire-verification.md) — loopback sign-in exchange → `api_key`, model list (22), quota, chat non-stream + SSE                                                        |


## Antigravity findings (`antigravity/`)


| Date       | Note                                                                                                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-03 | [Live wire verification (probes)](antigravity/2026-11-03-wire-verification.md) — `loadCodeAssist`/`fetchAvailableModels` control plane, mandatory project resolution, SSE chat surface, adapter takeaways |


## Clixad findings (`clixad/`)


| Date       | Note                                                                                                                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-11 | [Live verification ledger](clixad/2026-11-11-clixad-wire.md) — GitHub device-flow account, wallet, models, chat, referral/billing/streak surfaces observed live                          |


## Devin findings (`devin/`)


| Date       | Note                                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-06 | [Desktop 3.11.238 audit](devin/2026-11-06-devin-desktop-audit.md) — wire protocol, identity (Devin = Windsurf rebrand), device telemetry, installer, live OAuth capture                                 |
| 2026-11-07 | [Adapter proposal — oh-my-pi donor audit](devin/2026-11-07-oh-my-pi-devin-adapter-proposal.md) — ConnectRPC/protobuf at `server.codeium.com`, wire contract, phasing, test plan                          |
| 2026-11-07 | [Adapter proposal — final](devin/2026-11-07-devin-adapter-proposal-final.md) — full implementation flow, target structure, wire contract verified across 4 donors, phases, test plan                      |
| 2026-11-07 | [Inline-image wire debug](devin/2026-11-07-devin-image-wire-debug.md) — final paired-control verdict: neither model supports inline images; image code removed from the adapter                          |
| 2026-11-07 | [Live upstream verification](devin/2026-11-07-devin-live-upstream-verification.md) — first end-to-end proof against the real Cascade backend with a seat key; live-only bugs found and fixed             |


