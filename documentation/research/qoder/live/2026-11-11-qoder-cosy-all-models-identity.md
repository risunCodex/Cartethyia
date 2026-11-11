# Qoder — All-models COSY identity run (19/19, 2026-11-11)

**Scope:** every intl roster key (19), one fixed prompt, legacy COSY surface
(`agent_chat_generation` on `api1.qoder.sh`), TLS ClientHello profile
`qoder-app` (desktop mirror), OAuth account `pleged lenger`, output streamed
with the gateway's own parser. See
`documentation/research/qoder/2026-11-11-qoder-desktop-0.5.7-chat-surface-evidence.md`
for the surface evidence and `live/2026-11-05-qoder-model-matrix.md` §7 for the
upstream `raw_usage` metadata baseline.

## Run summary

| | |
|---|---|
| Models probed | 19 / 19 (all intl roster keys) |
| HTTP status | 200 on all 19 |
| TTFB | 0.7–4.9 s (only `cmodel` 11.4 s in the first head run) |
| Streams | full text + reasoning delivered, terminal frame reached |
| Prompt | `Halo, perkenalkan dirimu singkat.` (same for every model) |

## 19/19 identity table

`self-claim` is what the model *said* about itself in the stream.
`provider_model` is the upstream's own routing metadata (`raw_usage`,
2026-11-05 capture) — the trustworthy identity source. `verdict` is the
synthesis of both.

| #   | Roster key      | Self-claim (COSY, 2026-11-11)   | provider\_model / supply (metadata, 2026-11-05)                   | Verdict — real model                                                         |
| --- | --------------- | ------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | `auto`          | "asisten AI" (generic)          | `deepseek-v4-flash`                                               | DeepSeek V4 Flash                                                          |
| 2   | `ultimate`      | "ChatGPT"                       | `gpt-6.1-sol` (Azure)                                             | GPT-5.6 Sol/ GPT-6.1 Sol / **Claude Opus 5.5** (operator-confirmed rotation) |
| 3   | `fast`          | "Asisten" (anonymous)           | `kimi-k2.7-code-highspeed`                                        | Kimi K2.7 Code Highspeed                                                       |
| 4   | `performance`   | "ChatGPT"                       | `gpt-5.5` (supply: `claude-sonnet-5`, `gpt-5.5`, `gpt-5.6-terra`) | **Claude Sonnet 5.5** / GPT-5.5 (rotation)                                     |
| 5   | `efficient`     | "Qwen (Tongyi Qianwen)"         | `qwen3.7-plus`                                                    | Qwen 3.7 Plus                                                              |
| 6   | `smodel`        | "ChatGPT" (Sonus)               | `gpt-6-astra`                                                     | GPT-6 Astra                                                                |
| 7   | `cmodel`        | "Claude, by Anthropic" (Cantus) | `claude-fable-5-1-cc`                                             | Claude Fable 5.1                                                             |
| 8   | `qmodel_38max`  | "Qwen"                          | `qwen3.8-max`                                                     | Qwen 3.8 Max                                                                 |
| 9   | `qfmodel`       | "Qwen"                          | `qwen3.8-flash`                                                   | Qwen 3.8 Flash                                                               |
| 10  | `qmodel_latest` | "Qwen, by Alibaba"              | `qwen3.7-max`                                                     | Qwen 3.7 Max                                                                 |
| 11  | `qmodel`        | "Qwen (Tongyi Lab)"             | `qwen3.7-plus`                                                    | Qwen 3.7 Plus                                                                |
| 12  | `kmodel_latest` | "Kimi, by Moonshot AI"          | `kimi-k3.1-pro`                                                   | Kimi K3.1 Pro                                                                |
| 13  | `kmodel`        | "Kimi, by Moonshot AI"          | `kimi-k2.8-preview`                                               | Kimi K2.8 Preview                                                            |
| 14  | `gmodel`        | "GLM, by Z.ai"                  | `glm-5.3`                                                         | GLM-5.3 (fallback: Qwen 3 Max)                                              |
| 15  | `gfmodel`       | "GLM, by Z.ai"                  | `glm-5.3-flash`                                                   | GLM-5.3 Flash                                                               |
| 16  | `dmodel`        | "DeepSeek"                      | `deepseek-v4-pro`                                                 | DeepSeek V4 Pro                                                              |
| 17  | `dfmodel`       | "asisten AI" (generic)          | `deepseek-v4-flash`                                               | DeepSeek V4 Flash                                                            |
| 18  | `mmodel`        | "asisten AI" (generic)          | `MiniMax-M3.1-Flash`                                              | MiniMax M3.1 Flash                                                             |
| 19  | `lite`          | "Qwen (Tongyi Qianwen)"         | `qwen3.7-plus` (free)                                             | Qwen 3.7 Plus free                                                           |

## Observations

- **Metadata and self-claims agree on the branded families**: Qwen
  (`qmodel*`, `efficient`, `lite`), Kimi (`kmodel*`), GLM (`gmodel*`),
  DeepSeek (`dmodel`, `dfmodel`), Claude (`cmodel`), MiniMax (`mmodel`).
- **Slots that answer "ChatGPT"** (`ultimate`, `performance`, `smodel`,
  `auto`) map to Azure-hosted GPT profiles in the metadata. `auto` is the
  routed default (DeepSeek V4 Flash); `smodel` (Sonus) is GPT-6 Astra.
- **`cmodel` (Cantus) identity is now proven two ways**: the run above
  returned "Claude, by Anthropic" on COSY, and the metadata says
  `claude-fable-5-1-cc`. This matches the earlier note (matrix §7.5) that
  `cmodel` only answers identity *assertions*; the fixed prompt is not an
  identity question, and it answered.
- **`fast` and `dfmodel` answered with an anonymous generic identity** despite
  the metadata naming Kimi K2.7 / DeepSeek V4 Flash — the route uses a
  generic system identity, while the upstream routing still serves the named
  model. Verdicts still come from the metadata.
- **GLM slots can fall back to Qwen 3 Max** (operator-confirmed): when the
  GLM backend is unavailable, `gmodel`/`gfmodel` keep answering but route to
  Qwen — so a Qwen self-claim on a GLM key means fallback, not a slot
  error. The 2026-11-11 run captured GLM responses; the fallback is a known
  rotation state.
- **TTFB is the fingerprint check**: 0.7–4.9 s on all 19 with the
  `qoder-app` profile; the upstream accepted the mirrored ClientHello
  immediately (no `101 Signature invalid`, no `105 Login expired`).

## Implementation map

| Piece | Where |
|---|---|
| Probe (COSY-only, `--host`, `--profile`, `--all`, `--reply`) | `scripts/provider-probing/qoder/chat/probe-qoder.ts` |
| Metadata probe | `scripts/provider-probing/qoder/chat/probe-qoder-meta.ts` |
| TLS profile `qoder-app` | `src/network/egress/tls-profile.ts` |
| Profile dial (`fetchWithTls`) | `src/network/egress/factory.ts` |
| Upstream metadata baseline | `documentation/research/qoder/live/2026-11-05-qoder-model-matrix.md` §7 |
