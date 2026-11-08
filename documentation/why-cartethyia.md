# Why Cartethyia exists

The reasoning behind this project: what problem it was built for, what it does
differently from the gateways around it, and which behaviors exist here and
nowhere else.

This page is the story. For indexes and procedures, use the
[project README](../README.md) and `.skills/`.

## The problem

AI clients — OpenCode, Droid, Cline, Claude Code, Codex, and the rest — each
speak their own dialect and each expect their provider to behave a particular
way. Point them at an arbitrary compatible endpoint and three things break:

1. **Identity.** Providers read the client: exact headers, session correlation
   ids, a current client version in the user agent, and billing signals. Send a
   generic call and the provider answers differently — or refuses, as OpenCode's
   free tier does with `403 FreeTierError` for anything that is not
   agent-shaped.
2. **Operations.** Which account should serve this request, is it healthy, has
   it hit a quota, is it cooling down, which egress should it leave through, and
   what happens when it fails. Most proxies answer "send it somewhere else".
3. **Evidence.** When something fails you need to see the whole hop: what the
   client sent, what was translated, what the provider returned, what the client
   got.

Cartethyia exists to own all three, on one self-hosted process, without a
control plane you have to rent.

## Built from zero on Bun and Elysia

This is not a fork and not a wrapper around an existing gateway. It is written
from nothing:

- **Runtime: Bun.** One process, TypeScript executed directly, no build step
  between source and run. The tray app, the CLI, and the server are the same
  runtime.
- **HTTP layer: Elysia.** Chosen instead of Next.js for the console and API:
  a plain HTTP layer over Bun's server, so the console is a static React bundle
  served by the same process that proxies traffic — no React server runtime,
  no bundler memory footprint.
- **Data: embedded SQLite or PostgreSQL, Redis optional.** Start with no
  database server; move up without rebuilding. The PostgreSQL baseline is
  canonical and the SQLite DDL is generated from it, so both backends carry the
  same numbered migrations.

## What is different here

Many gateways translate a request and forward it. The differences that matter
in practice:

| Elsewhere | Here |
| --- | --- |
| One generic request shape for every provider | Per-provider adapters that reproduce the client identity, headers, and billing signals that provider expects |
| Credentials treated uniformly | OAuth behavior stays on the OAuth adapter; an API key is never silently treated as an OAuth client |
| A pinned client version in a header forever | Client versions are discovered in the background and written into provider headers |
| Retry means "try the next one" | Failover still runs admission, usage, quota, and telemetry — a retry counts |
| One failure shape | Disabled, exhausted, cooling down, missing model, and a dead pool are distinct answers, not all 502 |
| Opaque | Bounded, redacted capture of all four surfaces of a request |

## Custom-built capabilities

These are implemented here from scratch, shaped by operating this gateway — not inherited from another project. A few of them (the background-discovered version headers, the per-model cooldown, the CLI config injection) we have not seen done this way elsewhere; the rest are our own take on known ideas (aliasing, sharing, quota floors), built to fit how this gateway routes, accounts, and observes traffic:

- **Auto-updating client version headers.**
  [`src/providers/operations/client-versions.ts`](../src/providers/operations/client-versions.ts)
  holds one table of discovered-then-pinned version sources per client, refreshed
  in the background by a scheduled worker and written into the provider's
  headers. A provider that starts rejecting an old build keeps working without
  anyone editing a constant.
- **CLI model mapping.** Reroute a CLI tool's *native model slots*
  (`opus`, `sonnet`, …) to operator-chosen targets, scoped per API key, and
  inject the result into the tool's own config file. See
  [CLI model mapping](features/01-cli-model-mapping.md) and the injectors under
  [`src/console/cli-tools/injectors/`](../src/console/cli-tools/injectors/).
- **Per-model cooldown.** A 429 or a refusal can be scoped to one
  `(account, model)` pair instead of the whole account: `modelCooldowns` carries
  per-model expiry while the account stays routable for every other model. The
  dashboard counts that model down independently of the account's own cooldown.
- **Automatic proxy binding and rotation.** Pools are the egress a request
  leaves through. Candidates can require a pool, and a route's pool strategy
  (`round_robin` with its own rotation cursor, or weighted least-loaded) decides
  which one each dispatch takes. Background work — quota refreshes, daily
  check-ins — rotates egress per account so it spreads across addresses instead
  of hammering one. See [Network pools](features/03-network-pools.md).
- **Usage floor.** Accounts whose remaining quota sits at or below a provider
  threshold are skipped before they are dialed. See
  [Usage floor](features/04-usage-floor.md).
- **Share keys.** A public link enrolls a child API key under a parent's
  policy, so recipients spend against the parent's budget and inherit its
  limits. See [Share keys](features/05-share-keys.md).
- **Routing aliases and combos.** Name a model something else, or fan one name
  out across several with weighted failover. See
  [Routing aliases and combos](features/02-routing-aliases-combos.md).
- **Buddy media generation.** Images and submit/poll video tasks through Buddy
  providers, including the undocumented polling contract — see
  [Buddy media generation](features/07-buddy-media-generation.md).
- **Buddy CLI identity.** Device-token identity and per-account binding for
  the Buddy family — see [Buddy CLI identity](features/06-buddy-cli-identity.md).
- **Cursor provider.** The Run protocol adapter, entitlement, and quota — see
  [Cursor provider](features/08-cursor-provider.md).
- **Wire dialects.** How a request is translated per provider dialect — see
  [Wire dialects](features/09-wire-dialects.md).
- **Thinking-effort ladder.** Effort-level translation across providers — see
  [Thinking effort ladder](features/10-thinking-effort-ladder.md).
- **Built-in remote debugging.** Pull a recorded request off a running instance
  and replay it until one field flips the status. That method is how the
  OpenCode free-tier gate was solved.

## Reverse engineering is part of the work

Providers change their gates without announcing them, and the fix is not
guessable from a status code. The OpenCode free-tier gate is the worked
example: the CLI ignores proxy environment, so the dispatch had to be captured
by redirecting the provider through its own config, and the fix was bisected
to a 200 by changing one field at a time against a byte-exact replay.

The lesson worth keeping: when several fields are wrong at once, changing one
at a time never flips the status. Capture a real request, then correct the whole
shape. The repeatable method is in the
[trace-replay skill](../.skills/cartethyia-trace-replay/SKILL.md); the
[reverse-engineering skill](../.skills/cartethyia-reverse-engineering/SKILL.md)
covers inspecting an external client.

## Credit

The **Providers** and **CLI Tools** pages in the dashboard take their reference
from **ninerouter**. Their layout and model/CLI presentation follow that
project's approach; the gateway underneath — routing, dispatch, adapters,
telemetry, and the console API — is this project's own.

## Where to go next

- [Installation](installation.md) — install and choose a database mode.
- [Project README](../README.md) — product overview and installation entrypoint.
- [Feature docs](features/) — CLI mapping, routing, pools, quota, share keys.
- [Reference](reference/) — configuration, errors, providers, deployment.
