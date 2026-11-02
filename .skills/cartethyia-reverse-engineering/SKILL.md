---
name: cartethyia-reverse-engineering
description: "Use when reverse-engineering behavior within the Cartethyia codebase: trace an undocumented feature, reconstruct a request/data flow, map ownership across layers, or explain existing behavior before changing it."
---
# Reverse-engineer Cartethyia behavior

Use this skill to understand behavior implemented by this repository. This is
codebase-level reverse engineering: reconstruct Cartethyia's own request,
state, routing, persistence, provider, or dashboard behavior from its source
and tests. It is not a generic workflow for investigating unrelated software
or external systems.

## When to use

- The user asks how an undocumented Cartethyia feature or behavior works.
- A symptom crosses layers and its canonical owner is unclear.
- Existing behavior needs to be reconstructed before a fix, migration, or
compatibility change.
- The user asks to "reverse" or map a Cartethyia flow from observed behavior.

For a reproducible failing request, wire payload, provider response, or live
dispatch, continue with
[`cartethyia-trace-replay`](../cartethyia-trace-replay/SKILL.md). For a focused
domain change, use the closest skill listed in `AGENTS.md`.

## Procedure

1. **Bound the question.** State the observed behavior and the exact question
 to answer. Choose the smallest relevant boundary: public endpoint, console
 action, provider capability, state transition, or stored record.
2. **Find the canonical owner.** Read `AGENTS.md` and identify the production
 owner and its tests. Prefer code intelligence or targeted symbol/search
 queries over broad repository-wide scans.
3. **Trace both directions.** Follow inputs through validation and parsing,
 canonical representation, policy/routing, provider or persistence effects,
 and output encoding/UI. For stateful behavior, include the writer, reader,
 lifecycle, and reset/migration path. Follow actual call sites and dispatch
 boundaries rather than assuming similarly named modules are connected.
4. **Separate evidence from inference.** Support each important step with the
 owning symbol, test, or observed output. Label unverified assumptions and
 conflicting/stale comments; do not promote a plausible explanation to fact.
5. **Check invariants and alternatives.** Look for capability gates,
 provider-specific behavior, degradation/failover, retries, cache keys,
 time-dependent inputs, normalization, and error paths that could change the
 outcome. Search consumers before recommending a change to a shared contract.
6. **Reproduce only when useful.** Prefer focused tests and fake transports.
 Use the disposable database configured with `CARTETHYIA_TEST_DATABASE_URL`
 for persistence behavior. Live gateway
 verification must use the authorized local setup and redact credentials,
 session identifiers, and sensitive payloads. Do not probe external
 providers directly unless the user explicitly authorizes a safe probe.
7. **Report a compact behavior map.** Give the observed flow in order, cite
 relevant files/symbols, state what is proven versus unknown, and name the
 smallest next step. If implementation is requested, make the focused change
 and verify its acceptance criterion instead of stopping at analysis.

## Cartethyia flow landmarks

- Gateway surfaces parse OpenAI Chat, Responses, Anthropic Messages, and other
supported inputs into the canonical request model.
- Routing and admission decide whether a model/account/capability can serve
that request; retries and degradation are policy-controlled.
- Provider adapters own provider-specific auth, headers, endpoint selection,
wire translation, and stream decoding.
- Canonical usage and events feed response encoding, telemetry, and the
dashboard.
- Console API and dashboard behavior has separate owners; keep the browser
dashboard free of backend-only modules and secrets.

Treat this list as navigation, not a substitute for checking current code.
Locate the current implementation and tests before drawing conclusions.

## A desktop client that behaves differently

When the question is why something works in a desktop client but not here, the
investigation leaves Cartethyia's own source for the client's bundle. Inspect it
statically — never launch an installer or extracted executable to discover its
behavior — and pin the exact installed build before trusting any public source.
What this repo has learned from doing it:

- Pin the installed build before trusting any public source. A nearby version
corroborates; it does not describe the bundle you have.
- A picker label is not a model id. `auto` was a synthetic routing mode sent to
its own path, and `model: "auto"` on the ordinary endpoint was rejected.
- A catalog listing is not an entitlement. Models listed by `/models` were
rejected by `/responses`.
- A probe rejected at API-version validation never read the body, so it says
nothing about the body. Stop and mark the contract unknown.
- Inference-only headers belong in the adapter's request-time path, not in a
constant shared with OAuth and catalog calls.
- **Grep by surrounding context, not by name.** Minified bundles scramble names
(`Ldn={ACTIVITY:"/algo/..."}` says nothing), but string literals survive —
search for a known literal (`sash/api`, a message text, a base64 salt) and pull
±400-character windows, then chase the private constant at its call sites. This
found an entire undocumented claim-API family no public source described
(Qoder's activity endpoints, 2026-10).
- **Capture the real request when the guess grid 403s.** Once the wire rejects
every signature variant, stop mutating guesses — grids burn calls and prove
nothing — and dump the client's own request: a one-line `https.request`/
`http.request` wrapper prepended to the shared-process/main-process bundle,
appending host/method/path/headers to a scratch file. Check the client's own
`logs/**/network.log` too. Back up the file and restore it byte-for-byte
afterward — a reverse session is not entitled to change the installed build.
Qoder's gateway signature turned out to hash the *content-length string*, a
shape no amount of guessing would have yielded (method and findings in
[`documentation/archive/research/11-Qoder-30-10-2026-trial-activity-claims.md`](../../documentation/archive/research/11-Qoder-30-10-2026-trial-activity-claims.md)).
- **Capture a native/CLI client's TLS with a real MITM proxy.** For a Rust or
  native binary, prepending a wrapper is impossible and `AWS_ENDPOINT_URL` is
  unreliable — run it through mitmproxy with its CA trusted in the Windows root
  store, and extract flows to UTF-8 files. Proven recipe and pitfalls in
  [`references/capturing-client-https-traffic.md`](references/capturing-client-https-traffic.md).
  It yielded the Kiro CLI's exact path (`POST https://runtime.us-east-1.kiro.dev/`
  root, not `/generateAssistantResponse`), headers (`aws-sdk-rust/1.6.0 …
  app/AmazonQ-For-CLI`, `x-amzn-codewhisperer-optout: false`,
  `x-kiro-attempt`), and the camelCase `conversationState` body — facts the
  string scan had gotten wrong.
- **Electron desktop bundles: pin the app, then separate the main bundle from
  the CLI binary.** OpenCode desktop 2.2.5 (`ai.opencode.desktop`) ships a
  `app.asar` (main/preload/renderer chunks, hashed names like `main-*.js`,
  `HttpClient-*.js`, `Latch-*.js`, `Undici-*.js`) plus a separate
  `opencode-cli` binary; the update endpoint is `https://opencode.ai/update/api/latest/desktop/opencode/`.
  Evidence ledger: [`references/opencode-desktop-2.2.5.md`](references/opencode-desktop-2.2.5.md).
- **A single-file CLI binary (Mach-O/ELF) responds to string scanning before
  any wire probing.** Grok 1.0.70 (macOS aarch64, Mach-O magic `CF FA ED FE`)
  revealed its auth/D2C surface from strings alone: `GROK_CHI_CHAT_PROXY_BASE_URL`,
  OIDC loopback (`http://127.0.0.1/callback`), `/billing?format=credits`,
  `grok.com?_s=usage`, `api.x.ai`/`console.x.ai`, and MCP transport hints — no
  network calls needed to map the surface.

Keep an evidence ledger: question, source and version, observed result, and
what is still unknown. Turn only the verified rows into a Cartethyia change,
and exercise it with a fake transport. A diff against another client's source
is a hypothesis, not evidence.

## A provider with a CLI or npm package

When the client is shipped as a package rather than an installed app, the
package is often the *better* source: it is the exact version, it is on disk
without launching anything, and it frequently ships protocol definitions the
installed app has already discarded.

1. **Fetch the package without installing it.** `npm pack <name>` downloads the
   tarball and touches nothing on the machine. Extract it with `tar -xzf` into a
   scratch directory outside the repo, and do not run its `postinstall` — it is
   where a package downloads binaries at install time, which is exactly what a
   static inspection must avoid.
2. **Read the protocol definitions first.** A `*.proto`, a catalog JSON, or a
   `package.json` `files` list answers more than the bundle and never lies about
   itself. The bundle is the fallback, not the entry point.
3. **Expect the bundle to be obfuscated.** Minified bundles rename everything and
   encrypt string literals; a `grep` for the field name you want returns zero
   hits and that is not evidence the field is absent. Decode what is decodable
   (a small XOR/base64 string helper is usually declared at the top of the file)
   and then follow the *data* instead: field names that survive, function
   signatures that receive the value, and the protobuf field numbers.
4. **Note what is downloaded at runtime.** A native module or a WASM signer that
   is not in the package is a real limit, not a failure of the method. Record it
   as unknown rather than substituting a guess — the package tells you the
   shape of the call even when it cannot tell you the body.

The same discipline as above applies: pin the exact version you extracted, and
turn only the verified rows into a change.

## Unpacking an installer (MSI/EXE) statically

When the shipped client is an installer and the goal is the real wire behavior,
unpack it — never launch it. The installed program is the authority; docs and
source are hypotheses. This is the working recipe for Windows installers.

1. **Identify the container first.**
   - MSI = OLE compound document (magic `D0 CF 11 E0`). Extract with `7z x`
     (or `msiexec /a` for an administrative install). The payload is often a
     single large `*.exe` or `cab1.cab`.
   - EXE = MZ PE. `7z x` lists PE sections; the real payload is usually a
     bundled installer framework. Check the PE manifest resource
     (`.rsrc\1033\MANIFEST\1`) to identify the framework: Inno Setup reports
     `JR.Inno.Setup`, NSIS reports `Nullsoft Install System`, etc.
2. **Inno Setup payloads: use `innoextract`, not 7z.** The `[0]` file 7z
   emits is the Inno *container*, not a standalone LZMA/LZMA2 archive — probing
   LZMA offsets into it is wasted time. Use `innoextract` on the original EXE:
   - Official `innoextract` 1.9 (2020, portable zip from constexpr.org)
     supports Inno Setup through **6.2.2** only.
   - For Inno Setup 6.4+ (e.g. a 2026 IDE), use the maintained fork release
     `crazy-max/innoextract` v1.13.0+ (supports through 7.1.0). Verify the
     downloaded binary against the SHA256 digest in the GitHub release API
     (`api.github.com/repos/crazy-max/innoextract/releases`) before running it.
   - A `Unexpected setup data version: x.y.z` from the old tool does not mean
     the file is corrupt — it means the framework version is newer than the
     extractor. Record the version and get a newer extractor.
3. **The app inside is usually Electron/VS Code.** After a successful Inno
   extraction, look for `resources/app/package.json` (product metadata,
   `version`, `distro`, license like `AWS-IPL`) and `node_modules.asar`.
   - `7z` cannot open `.asar`. Use the repo's ASAR reader
     (`scripts/tools/asar-unpack.mjs`, read-only, `bun scripts/tools/asar-unpack.mjs <a.asar> <outdir> [filter]`).
     Observed nativev2 layout: 16-byte pickle header → `[u32 @12]` is the JSON
     length → JSON starts at offset 16 → `header.files` is the root *container*,
     so walk its children directly. **Offsets may be relative to the data
     section start (16 + headerSize)** — the script auto-detects absolute vs
     relative from the first leaf; reading a relative-offset asar as absolute
     yields garbage bytes (OpenCode desktop 2.2.5 shipped one).
   - The client's *own* version is in `package.json`/`product.json` — read it
     from there, not from the installer filename.
 4. **Disk images (DMG) extract with 7-Zip on Windows.** A `.dmg` is a UDIF
    container (zlib-compressed, magic `78 01 …`) and 7-Zip opens it directly:
    `7z x app.dmg -o<dir>` yields a `*.hfs` partition, and a second
    `7z x 4.hfs -o<dir>` extracts the volume (an `OpenCode.app` style bundle).
    No `hdiutil`/`dmg2img` needed on Windows.
4. **Scan large single-file binaries (Bun/Rust) with a streamed string
   extractor.** A 466 MB Bun executable is not a bundle to open in an editor;
   write a chunked scanner (32 MiB reads with overlap, printable-ASCII
   `{6,}` regex) and grep the output for URLs, salts, User-Agent fragments,
   and header names. This is how the Kiro CLI machine-id salts, `Kiro-CLI`
   UA, and KAS/ACP endpoints were recovered.
5. **Keep the evidence ledger.** Record build pinned, tool + hash used, files
   inspected, and each proven row. Save it beside the other dated ledgers
   (e.g. `references/` in this skill, or `documentation/archive/research/`).
   Example: `references/kiro-ide-cli-protocol.md`.

## Safety and scope

- Inspect only code, tests, fixtures, logs, and local runtime behavior that the
user is authorized to access.

- Do not edit generated output or unrelated code while tracing behavior.