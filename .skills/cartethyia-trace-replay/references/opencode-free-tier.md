# OpenCode free tier — pointer

The consolidated free-tier research (wire shape, gate requirements, refusals,
anonymous-auth verdict, replay evidence) lives in one merged reference in the
research folder:

**`documentation/research/opencode/2026-11-02-opencode-free-tier.md`**

Quick orientation while working:

- Two different refusal classes exist; do not confuse them:
  - **403 `FreeTierError` from every permutation, and the official client
    fails too** → egress IP is blocked (change egress; nothing in the request).
  - **403 only on one shape** → request shape (tools/stream/wire): `stream:true`
    required, agent-tool fingerprint required (≥3 tools; we send the 11-set),
    `user-agent` version segment ≥1.18.0, `ses_` id with counter 1–63.
- **429 `FreeUsageLimitError` is quota/IP state, not a wire refusal** — do not
  change the wire; check quota/egress.
- Free dispatches send **no `Authorization`** (the anonymous `Bearer public`
  sentinel was removed 2026-11-02; absent auth verified 200 live).
- Binary/source evidence: `documentation/research/opencode/2026-11-02-desktop-2.2.5-binary-evidence.md`.
