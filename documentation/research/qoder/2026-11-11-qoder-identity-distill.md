# Qoder — 19/19 identity distill (2026-11-11, response self-claims)

Prompt: "Perkenalkan dirimu secara lengkap: sebutkan nama model yang TEPAT,
versi/rilis, dan siapa pembuatmu (perusahaan). Jangan menghindar, sebutkan
identitas persismu." (run 1; `ultimate`/`cmodel` retried with a plain
self-introduction prompt after 403/416 on the long prompt).

Method: `probe-qoder.ts` through the gateway's own `callQoder` transport
(app profile default), parsed from the streamed answer text + reasoning.
This run **replaces** the earlier metadata-based identification
(`raw_usage`/`provider_model` no longer visible upstream).

| Roster key | Self-claim | Maker |
|---|---|---|
| `auto` | ChatGPT | OpenAI |
| `ultimate` | Claude | Anthropic |
| `fast` | Kimi | Moonshot AI |
| `performance` | Claude | Anthropic |
| `efficient` | Qwen3.8 | Tongyi Lab / Alibaba |
| `smodel` | ChatGPT (OpenAI API) | OpenAI |
| `cmodel` | Claude | Anthropic |
| `qmodel_38max` | Qwen | Alibaba Group |
| `qfmodel` | Qwen | Tongyi Lab / Alibaba |
| `qmodel_latest` | Qwen | Alibaba Group |
| `qmodel` | Qwen | Tongyi Lab / Alibaba |
| `kmodel_latest` | Kimi | Moonshot AI |
| `kmodel` | Kimi | Moonshot AI |
| `gmodel` | GLM (GLM-4) | Z.ai |
| `gfmodel` | GLM | Z.ai |
| `dmodel` | Claude | Anthropic |
| `dfmodel` | ChatGPT | OpenAI |
| `mmodel` | ChatGPT | OpenAI |
| `lite` | Qwen | Tongyi Lab / Alibaba |

Notes:
- Multi-supplier slots confirmed again: `ultimate`/`performance` (Claude +
  GPT Sol variants), `smodel`/`dfmodel`/`mmodel` (ChatGPT/OpenAI).
- `ultimate` answered 403 `authentication_failed` on the long identity prompt
  but 200 + Claude on a short prompt; `cmodel` answered 416 on the long
  prompt and 200 + Claude on a short one — the long prompt itself is what
  trips the slot, not the wire.
- `qmodel_38max`, `qmodel_latest`, `qmodel`, `efficient`, `qfmodel`, `lite`
  all claim Qwen (Alibaba/Tongyi Lab) — GLM→Qwen fallback evidence from the
  earlier matrix run applies to the `gmodel`/`gfmodel` keys.
- Preview identity (earlier matrix run, 2026-11-11, archived in
  `archive/qoder-research-archive-2026-11-11.zip` → `2026-11-05-qoder-model-matrix.md`
  §7) is consistent: Claude on `dmodel`/`cmodel`/`ultimate`/`performance`,
  ChatGPT on `dfmodel`/`mmodel`/`auto`, Kimi on `kmodel`*, GLM on `gmodel`*,
  Qwen on `qmodel`*/`lite`.
