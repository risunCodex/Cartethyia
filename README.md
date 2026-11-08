# Cartethyia

<img width="1200" height="393" alt="og_image" src="dashboard/public/assets/brand/og_image.webp" />

**A self-hosted multi-provider AI gateway.**

[![License: GPL-3.0-only](https://img.shields.io/badge/License-GPL--3.0--only-blue.svg)](LICENSE)
[![Contributor Covenant](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](CODE_OF_CONDUCT.md)

Cartethyia gives AI clients one stable, OpenAI and Anthropic-compatible endpoint. Behind it, the gateway handles the operational work: provider-aware translation, account selection, health-aware failover, quota and cooldown enforcement, usage accounting, telemetry, and optional proxy pools.

Cartethyia is more than a router. Routers move bytes; Cartethyia runs a system — it watches your accounts, feels when one gets tired, and quietly routes around it before you ever notice. It lives between you and the models you trust: one stable, OpenAI and Anthropic-compatible endpoint, with every provider's dialect spoken for you.

Configure provider accounts once, issue an API key, and point OpenCode, Kilo, Droid, Cline, Claude Code, Codex, ZCode, or any compatible client at Cartethyia. The client keeps its native protocol; Cartethyia normalizes the request, selects a viable route, dispatches upstream, and returns the response in the contract the client expects.

Built with Bun, TypeScript, Elysia, embedded SQLite or external PostgreSQL, and optional Redis coordination.

> **Repository availability**
>
> - **GitHub:** <https://github.com/risunCodex/Cartethyia>
> - **npm:** <https://www.npmjs.com/package/cartethyia>
>
> The dashboard and console point at the GitHub primary. Stars and forks are
> appreciated there — they are the only ones that count.

## <img src="https://api.iconify.design/lucide/download.svg?color=%238b949e" width="20" height="20" alt=""> Installation

You need Node/npm for installation and **Bun 1.4.0 or newer** to run.

```bash
npm install -g cartethyia
cartethyia setup
carte
```

Install it **globally**. A local install drops `cartethyia`/`carte` into
`./node_modules/.bin/` — not on your `PATH`, so the commands won't be found.
Use `npx cartethyia` for a local run.

Update and remove:

```bash
npm update -g cartethyia    # update the npm package itself
cartethyia update           # update the running install (binary/config refresh)
npm uninstall -g cartethyia # uninstall
```

### Everyday commands

| Command | What it does |
| --- | --- |
| `carte` | Start the gateway in the background, then show a terminal menu (console, reset password, backup, update, exit) — works over SSH / headless |
| `carte --tray` | Start with a system-tray icon instead (needs a graphical session) |
| `cartethyia menu` | Re-attach the arrow-key menu to a running gateway |
| `cartethyia start` | Start the gateway without a menu |
| `cartethyia stop` | Stop the detached gateway (also `./carte stop` after an install) |
| `cartethyia doctor` | Check the install: config, database mode, ports, binary health |
| `cartethyia update` | Update the running install (release refresh) — distinct from `npm update -g` |
| `cartethyia setup [--non-interactive]` | Re-run setup (Lite vs Full, config paths) non-interactively |
| `cartethyia admin reset-lockout <username> <clientIp>` | Unlock a locked console account |
| `cartethyia admin reset-lockout --all` | Unlock every locked console account |
| `cartethyia telemetry reconcile --apply` / `--verify` | Reconcile telemetry state |

Full guide (modes, Docker, VPS, systemd, one-shot script):
[installation](documentation/installation.md).

## <img src="https://api.iconify.design/lucide/sparkles.svg?color=%238b949e" width="20" height="20" alt=""> What it actually does

- **Speaks the provider's own dialect.** Per-provider adapters reproduce the
  client identity, headers, and billing signals the provider expects.
- **Routing looks at health.** Model, alias, combo, capability, account state,
  cooldown, quota, and whether the provider is up — one decision, one plan.
- **A retry still counts.** Failover does not skip admission, usage, quota, or
  telemetry; failures stay distinct instead of collapsing to one 502.
- **You can see the whole hop.** Bounded, redacted capture of what the client
  sent, what Cartethyia translated, what the provider returned, and what the
  client got.

The full capability list, and how it differs from plain forwarders:
[Why Cartethyia](documentation/why-cartethyia.md).

## <img src="https://api.iconify.design/lucide/image.svg?color=%238b949e" width="20" height="20" alt=""> Showcase

One install, one console: watch traffic land, watch accounts stay healthy,
and change routing without restarting anything.

<table>
<tr>
<td align="center"><img src="documentation/assets/screenshots/overview.png" width="100%" alt="Overview" /><br /><b>Overview</b><br /><sub>Gateway endpoint, remote support, and compression</sub></td>
<td align="center"><img src="documentation/assets/screenshots/usage.png" width="100%" alt="Usage" /><br /><b>Usage</b><br /><sub>Volume, latency, cached tokens, spend per model</sub></td>
</tr>
<tr>
<td align="center"><img src="documentation/assets/screenshots/quota-management.png" width="100%" alt="Quota Management" /><br /><b>Quota Management</b><br /><sub>Per-account quota windows, resets, and availability</sub></td>
<td align="center"><img src="documentation/assets/screenshots/proxy-pool.png" width="100%" alt="Proxy &amp; Requests" /><br /><b>Proxy &amp; Requests</b><br /><sub>Outbound proxy pools: capacity, latency, and health</sub></td>
</tr>
<tr>
<td align="center"><img src="documentation/assets/screenshots/model-lab.png" width="100%" alt="Model Lab" /><br /><b>Model Lab</b><br /><sub>Chat a routed model through the real gateway path</sub></td>
<td align="center"><img src="documentation/assets/screenshots/cli-tools.png" width="100%" alt="CLI Tools" /><br /><b>CLI Tools</b><br /><sub>Per-CLI model mappings and downloadable config</sub></td>
</tr>
<tr>
<td align="center"><img src="documentation/assets/screenshots/customization.png" width="100%" alt="Customization" /><br /><b>Customization</b><br /><sub>Background, transparency, and per-surface blur</sub></td>
</tr>
</table>

## <img src="https://api.iconify.design/lucide/route.svg?color=%238b949e" width="20" height="20" alt=""> Routes


| Route                      | For                                       |
| -------------------------- | ----------------------------------------- |
| `/v1/chat/completions`     | OpenAI-style chat                         |
| `/v1/responses`            | Responses API, including Codex tools      |
| `/v1/messages`             | Anthropic Messages, including Claude Code |
| `/v1/models`               | What this key can call                    |
| `/v1/completions`          | Legacy text completions                   |
| `/v1/responses/compact`    | Responses compaction                      |
| `/v1/search`               | Web search                                |
| `/v1/systemone`            | System One                                |
| `/v1/images/generations`   | Image generation                          |
| `/v1/videos/generations`   | Video generation                          |
| `/v1/embeddings`           | Embeddings                                |
| `/v1/audio/transcriptions` | Speech to text                            |
| `/v1/audio/speech`         | Text to speech                            |


Generation routes take an opaque body the provider's own adapter shapes —
whatever a model accepts is what it gets. Images: Gemini, Antigravity, Codex,
Buddy family. Video: CodeBuddy only (`seedance-2.5`, async task polled to
completion).

Embeddings and both audio routes are **passthrough**: admission + accounting,
body forwarded untouched. No bundled adapter implements them — wire them to a
compatible upstream yourself; a model row with the matching service kind is all
that's needed.

A **custom** provider gets *every* service kind automatically, including these
three — it has no manifest row narrowing it. The upstream still decides what it
answers; a surface it doesn't speak returns its own error, not a gateway refusal.

## <img src="https://api.iconify.design/lucide/layers.svg?color=%238b949e" width="20" height="20" alt=""> Lite or Full

Same app either way. Lite is not a cut-down edition.

|          | Pick it when                                                                       |
| -------- | ---------------------------------------------------------------------------------- |
| **Lite** | One person, one machine, or you just want it running                               |
| **Full** | Several people, a VPS, or the process is busy enough that SQLite is the bottleneck |

Docker Compose defaults to Full; a local `.env` defaults to Lite. When Lite
gets tight, export a JSON backup and restore it into Full — no config rebuild.

Details: [Database modes and configuration](documentation/installation.md#database-modes-and-configuration).

## <img src="https://api.iconify.design/lucide/code-2.svg?color=%238b949e" width="20" height="20" alt=""> Development

From the repository root:

```bash
bun install
bun run dev              # backend with hot reload
bun run typecheck         # backend typecheck
bun run test              # full suite (backend + dashboard)
bun run test:backend      # backend suites (Lite + Full modes)
bun run test -- --scope dashboard   # dashboard suites only
bun run test -- --test-name-pattern admission   # filter by name
bun run dashboard:typecheck
bun run dashboard:test
bun run dashboard:dev     # dashboard dev server
```

Tests run in parallel (`CARTETHYIA_TEST_JOBS` overrides the default
`min(CPU cores, 4)`). Backend suites in `test/` mirror `src/`; dashboard suites
in `dashboard/test/`. `test:backend` also covers `test/cli/`; the heavier
installer/Docker contracts live in `test/integration/`. Full-mode suites need
`CARTETHYIA_TEST_DATABASE_URL` — never the runtime `DATABASE_URL`.

## <img src="https://api.iconify.design/lucide/scale.svg?color=%238b949e" width="20" height="20" alt=""> License

[GNU GPL v3.0 only](LICENSE). You can use, change, and share it. If you ship a
build or a fork, ship the source with it, under the same license. No warranty.

## <img src="https://api.iconify.design/lucide/heart.svg?color=%238b949e" width="20" height="20" alt=""> Community

- [Contributing](CONTRIBUTING.md) — workflow, code conventions, and pull requests.
- [Code of Conduct](CODE_OF_CONDUCT.md) — expectations for everyone in the community.
- [Security Policy](SECURITY.md) — how to report a vulnerability safely.