# OpenCode adapter wire vs capture — pointer

The full comparison (what the probe/adapter sends, the 11-tool set, the
system prompt, the diff vs the real CLI capture, and what actually causes a
refusal) is consolidated in the merged free-tier reference:

**`documentation/research/opencode/2026-11-02-opencode-free-tier.md`**

Quick orientation:

- The adapter/probe wire matches the real CLI wire (11 verbatim tools with
  `strict:false`, `stream:true`, session/project fingerprint, 2.x key order).
- **429 `FreeUsageLimitError` = quota/IP state**, not a wire refusal — proven
  by replaying the captured CLI flow verbatim (200 once quota recovers).
- Free dispatches send **no `Authorization`**.
