# OpenCode desktop 2.2.5 — pointer

The full binary evidence ledger (unpack trail, ASAR notes, bundle layout, live
probe results, request shape, real 2.2.0 CLI capture, replay tool + live 200,
binary-confirmed constants, Grok bonus) lives in the research folder:

**`documentation/research/opencode/2026-11-02-desktop-2.2.5-binary-evidence.md`**

Quick orientation:

- Desktop artifact `opencode-desktop-mac-arm64.dmg` = 2.2.5; CLI binary
  `opencode-cli` separate, version matches.
- Format: `app.asar` nativev2; offsets relative to data section start (16 +
  headerSize).
- The 2.2.5 binary has **no `FreeTierError`** — the free-limit guard is
  `FreeUsageLimitError` (quota/cooldown state).
- Real 2.2.0 CLI capture: chat wire = 11 tools (`strict:false`), key order
  `model,messages,tools,stream,stream_options,max_completion_tokens`, no
  `prompt_cache_key`/`cache`/`generation`.
- Replay of the captured flow → **200 SSE** for `glm-5.3-flash-free`.
- Sibling research: `2026-11-02-wire-shape-adapter-vs-capture.md`,
  `2026-11-02-free-tier-gate.md`,
  `2026-11-02-anonymous-auth-sentinel.md` (all under
  `documentation/research/opencode/`).
