# Qoder — Model Matrix & Roster Metadata (consolidated 2026-11-05)

**Consolidated from** (source files removed during the merge; final data is below):
- Run `model-matrix.ts` 150/150 (final) & snapshot 139/150 (initial) — results in `D:\tmp\qoder-sandbox\results\`.
- Roster metadata `raw_usage` (2026-11-04) — via console probe `POST /console/api/providers/qoder/models/probe` + dashboard model cards.

> Context from the Qoder research 2026-11-04 through 2026-11-05. Source dates
> are preserved per section. Tables & code blocks are kept verbatim.

## Table of Contents
- [1. Final Results — 150/150](#1-final-results--150150)
- [2. Initial Snapshot — 139/150 (before the fix)](#2-initial-snapshot--139150-before-the-fix)
- [3. Per Model — 15 roster keys](#3-per-model--15-roster-keys)
- [4. Per Surface & Per Case](#4-per-surface--per-case)
- [5. Error Patterns & Size/Speed](#5-error-patterns--size-speed)
- [6. Tool Calling Findings](#6-tool-calling-findings)
- [7. Roster Metadata — `raw_usage` (supply model / region / target)](#7-roster-metadata--raw_usage-supply-model--region--target)
- [8. Conclusions for the Adapter](#8-conclusions-for-the-adapter)

---

## 1. Final Results — 150/150

_Final run of `model-matrix.ts` (2026-11-05)._

**Method:** `model-matrix.ts` — 15 models × 2 surfaces (ide, grpc) × 5 cases
= 150 runs. OAuth `dt-`. Concurrency 5, timeout 120s.
**Results (final):** `D:\tmp\qoder-sandbox\results\matrix-full-150-120s-2026-11-04T22-12-43-176Z.jsonl`

### 1.1 Summary (150/150, IDE 75/75, gRPC 75/75)

| | Count |
|---|---|
| **OK** | **150 / 150 (100%)** |
| Fail | 0 |
| IDE/HTTP | 75/75 (100%) |
| gRPC | 75/75 (100%) |

### 1.2 Per Case (final)

| Case | OK | toolsCalled |
|---|---|---|
| plain | 30/30 | 0 |
| tools | 30/30 | 29 |
| parallel | 30/30 | 30 |
| tools_none | 30/30 | 5 |
| tools_required | 30/30 | 26 |

### 1.3 Per Model (final)

**All 15 models: 10/10** — including `cmodel`, `mmodel`, `smodel`,
`gmodel`, `qfmodel`, `qmodel_38max`, `dmodel`, `dfmodel`, which had failed on
gRPC tools.

### 1.4 Fix Journey (from the unpacked worker + live tests)

| Problem | Before | After | Source |
|---|---|---|---|
| gRPC tools `parameters` | `{fields:{}}` empty | full Struct (`structOf`/`SBA`/`Lat`) | worker `byl`/`SBA` |
| gRPC tool `description` | absent | `{value: desc}` (StringValue) | worker `xG` |
| gRPC tool `strict` | absent | `{value: bool}` (BoolValue) | worker `Uat` |
| gRPC `tool_choice` | `{structValue:{fields:{type}}}` | `{stringValue:"auto"}` | worker `Lat` |
| gRPC `tool_choice=required` | `{stringValue:"required"}` / Struct | omitted (gRPC rejects required) | upstream reject 400/406/422 |
| `cmodel` (Cantus) required | coercive prompt ("WAJIB…") → 406 `intention_rejected` | neutral non-coercive prompt → tool called | model guardrail (safety) |
| flaky timeout (qmodel_38max/grpc/plain) | timeout 60s → `Cancelled on client` | timeout 120s → pass | slow streams under concurrency |

Important note: the 406 on `cmodel` is **not** the model's inability to use
tools (regular tools work) — it is the guardrail rejecting prompts that are
coercive. A neutral prompt resolves it.

---

## 2. Initial Snapshot — 139/150 (before the fix)

_Pre-fix snapshot of `model-matrix.ts` (2026-11-05); failure history._

**Method:** `model-matrix.ts` — 15 roster models (1.1.83) × 2 surfaces (IDE/HTTP
`/model/v1`, gRPC `ChatService`) × 5 cases (plain, tools, tools_none,
tools_required, parallel) = **150 runs**. OAuth `dt-`, concurrency 5,
timeout 60s, non-blocking.
**Results:** `D:\tmp\qoder-sandbox\results\matrix-full-2026-11-04T21-54-29-466Z.jsonl`

### 2.1 Snapshot summary (139/150; IDE 75/75; gRPC 64/75)

| | Count |
|---|---|
| Total | 150 |
| OK | **139 (92.7%)** |
| Fail | 11 |
| IDE/HTTP | 75/75 OK (**100%**) |
| gRPC | 64/75 OK (85.3%) |

### 2.2 Per Model (initial)

| Model | OK | Fail | toolsCalled | toolsOK | finishTool |
|---|---|---|---|---|---|
| auto | 10 | 0 | 6 | 6 | 4 |
| ultimate | 10 | 0 | 6 | 6 | 0 |
| fast | 10 | 0 | 6 | 6 | 4 |
| efficient | 10 | 0 | 6 | 6 | 5 |
| smodel | 10 | 0 | 6 | 6 | 0 |
| **cmodel** | 6 | **4** | 3 | 3 | 0 |
| qmodel_38max | 9 | 1 | 4 | 4 | 3 |
| qfmodel | 10 | 0 | 6 | 6 | 6 |
| kmodel_latest | 10 | 0 | 4 | 4 | 3 |
| kmodel | 10 | 0 | 5 | 5 | 4 |
| gmodel | 10 | 0 | 6 | 6 | 3 |
| gfmodel | 10 | 0 | 7 | 7 | 4 |
| dmodel | 9 | 1 | 4 | 4 | 3 |
| dfmodel | 9 | 1 | 4 | 4 | 2 |
| **mmodel** | 6 | **4** | 3 | 3 | 3 |

Problematic models: **cmodel** (4 fails) & **mmodel** (4 fails) — all in gRPC tools.

### 2.3 Per Surface

| Surface | OK | toolsCalled |
|---|---|---|
| ide | 75/75 | 42 |
| grpc | 64/75 | 34 |

**IDE/HTTP = 100% stable.** gRPC fails only in specific tool cases.

### 2.4 Per Case

| Case | OK | toolsCalled | Notes |
|---|---|---|---|
| plain | 30/30 | 0 | ✅ all |
| tools | 28/30 | 26 | 2 fail (gRPC: cmodel, mmodel) |
| parallel | 28/30 | 28 | 2 fail (gRPC: cmodel, mmodel) |
| tools_none | 28/30 | **2** | 2 fail; only 2 models keep calling tools despite none |
| tools_required | 25/30 | 20 | **5 fail** — most problematic |

### 2.5 Error Patterns

| Error | Count | Occurs in |
|---|---|---|
| `grpc-status=13 Stream error: 400` | 10 | gRPC tools: cmodel (tools/none/parallel), mmodel (tools/none/parallel/required), dmodel/dfmodel/qmodel_38max (required) |
| `grpc-status=13 Stream error: 406` | 1 | cmodel/grpc/tools_required |

**Insights:**
- gRPC **rejects `tool_choice=required`** (400) for most models
  (dmodel, dfmodel, qmodel_38max, mmodel, cmodel). `cmodel` gets a 406.
- gRPC rejects **regular tools** for `cmodel` & `mmodel` (400) — these models
  are not compatible with tool-calls over gRPC.
- **IDE accepts everything** — not a single failure on the IDE surface.

### 2.6 Tool Calling Findings (initial)

- `tools_none`: only **2/30** models keep calling tools (probably
  `qfmodel`/`gfmodel`) — the rest obey `none`.
- `parallel`: 28/30 called 2-4 tools (parallel works).
- `tools_required`: 20/30 actually called a tool; 5 failed (gRPC), the rest
  answered with text without a tool (intention rejected).

### 2.7 Size/speed (sample)

| Model | Surface ms (median-ish) |
|---|---|
| dfmodel/ide | 1-2s (fast) |
| dfmodel/grpc | 2-4s |
| kmodel_latest/grpc | 9-13s (slow) |
| gfmodel/grpc/tools_none | 18s (slowest) |

---

## 3. Per Model — 15 roster keys

_Synthesis of [20] §3 vs [19] §2 (2026-11-05)._

All 15 roster keys pass **10/10** after the fix (final). Initial vs final
snapshot comparison:

| Model | Initial OK | Final OK | Notes |
|---|---|---|---|
| auto | 10/10 | 10/10 | — |
| ultimate | 10/10 | 10/10 | — |
| fast | 10/10 | 10/10 | — |
| efficient | 10/10 | 10/10 | — |
| smodel | 10/10 | 10/10 | — |
| **cmodel** | 6/10 | 10/10 | 4 initial fails (gRPC tools) + 406 guardrail |
| qmodel_38max | 9/10 | 10/10 | 1 initial fail (tools_required) |
| qfmodel | 10/10 | 10/10 | — |
| kmodel_latest | 10/10 | 10/10 | — |
| kmodel | 10/10 | 10/10 | — |
| gmodel | 10/10 | 10/10 | — |
| gfmodel | 10/10 | 10/10 | — |
| dmodel | 9/10 | 10/10 | 1 initial fail (tools_required) |
| dfmodel | 9/10 | 10/10 | 1 initial fail (tools_required) |
| **mmodel** | 6/10 | 10/10 | 4 initial fails (gRPC tools) |

---

## 4. Per Surface & Per Case

_Synthesis of [20] vs [19] (2026-11-05)._

**Per surface:**

| Surface | Initial OK | Final OK |
|---|---|---|
| ide | 75/75 | 75/75 |
| grpc | 64/75 | 75/75 |

**Per case:**

| Case | Initial OK | Final OK | toolsCalled (final) |
|---|---|---|---|
| plain | 30/30 | 30/30 | 0 |
| tools | 28/30 | 30/30 | 29 |
| parallel | 28/30 | 30/30 | 30 |
| tools_none | 28/30 | 30/30 | 5 |
| tools_required | 25/30 | 30/30 | 26 |

---

## 5. Error Patterns & Size/Speed

_Snapshot history from [19] §5 + §7 (2026-11-05); the final run has 0 fails._

**Error patterns (initial):**

| Error | Count | Occurs in |
|---|---|---|
| `grpc-status=13 Stream error: 400` | 10 | gRPC tools: cmodel (tools/none/parallel), mmodel (tools/none/parallel/required), dmodel/dfmodel/qmodel_38max (required) |
| `grpc-status=13 Stream error: 406` | 1 | cmodel/grpc/tools_required |

**Size/speed (sample, initial):**

| Model | Surface ms (median-ish) |
|---|---|
| dfmodel/ide | 1-2s (fast) |
| dfmodel/grpc | 2-4s |
| kmodel_latest/grpc | 9-13s (slow) |
| gfmodel/grpc/tools_none | 18s (slowest) |

> After the fix: **0 fails** across every surface/case — gRPC 400/406 errors no
> longer appear; timeout raised 60s → 120s for large/slow streams.

---

## 6. Tool Calling Findings

_Synthesis of [19] §6 (initial) + [20] §2/§3 (final) — 2026-11-05._

- `tools_none`: initially only **2/30** kept calling tools; final
  **5/30** (`toolsCalled=5`) — the majority obey `none`.
- `parallel`: initially 28/30 → final **30/30**; 2-4 tools called in parallel.
- `tools_required`: initially 20/30 actually called a tool (5 failed on gRPC,
  the rest answered with text without a tool); final **26/30** called a tool.
- The tool-call delta pattern is the same on IDE & gRPC (after unwrapping
  `fromProtoStruct`).
- gRPC tools fix: full `parameters` Struct (`structOf`/`SBA`/`Lat`),
  `description`/`strict` wrappers (`StringValue`/`BoolValue`),
  `tool_choice` `{stringValue:"auto"}`; `required` omitted (gRPC rejects it).

---

## 7. Roster Metadata — `raw_usage` (supply model / region / target)

_Capture console probe (2026-11-04); terminal `raw_usage` format — see also `documentation/research/qoder/archive/qoder-research-archive-2026-11-11.zip` (`2026-11-05-qoder-wire-reference-adapter-alignment.md`) §5–6._

Live capture of the provider metadata the IDE surface (`/model/v1`) echoes in
its terminal `raw_usage` frame for every Qoder roster key. This is the trusted
source for "which model really served this turn": the production transports
(gRPC / COSY) echo only opaque roster keys (`auto`, `lite`, `cmodel`, …),
while the metadata below is the only place the upstream names its real supply
model, region, and target.

Captured via the console probe (`POST /console/api/providers/qoder/models/probe`,
backend defaults Qoder probes to the IDE surface) and the dashboard model cards,
2026-11-04.

### 7.1 Full roster — verified live (20 key)

| Roster key | reportedModel (IDE echo) | provider_model | supply_model | supply_account | supply_region | model_level | target (routing/fallback) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `auto` | `auto` | `deepseek-v4-flash` | — | — | `global` | `auto` | `deepseek-v4-flash-qteam-new-260727` |
| `fast` | `fast` | `kimi-k2.7-code-highspeed` | `kimi-k2.7-code-highspeed` | — | `global` | `fast` | `oem-kimi-k2.7-code-highspeed-2026-6-13` |
| `performance` | `azure-gpt5.5` | `gpt-5.5` | `claude-sonnet-5, gpt-5.5, gpt-5.6-terra` | — | `code-17-est-01` | `performance` | `g55-global-code-lm-17-code-17-est-01-QCQEz4wL` |
| `efficient` | `efficient` | `qwen3.7-plus` | `qwen3.7-plus` | — | `global` | — | `bailian-qwen3.7-plus-newgateway-260602` |
| `ultimate` | `azure-gpt6.1-sol` | `gpt-6.1-sol` | `gpt-6.1-sol` | `code-lm-197` | `code-197-est-01` | `ultimate` | `g61s-[code-lm-197]-global-code-197-est-01-93iPyw==` |
| `dmodel` | `dmodel` | `deepseek-v4-pro` | — | — | `global` | `dmodel` | `oem-deepseek-v4-new-260727-1` |
| `dfmodel` | `dfmodel` | `deepseek-v4-flash` | — | — | `global` | — | `deepseek-v4-flash-qteam-new-260727` |
| `gmodel` | `gmodel` | `glm-5.3` | — | — | `global` | `gmodel` | `oem-glm-5-3-prod-260813` |
| `gfmodel` | `gfmodel` | `glm-5.3-flash` | — | — | `global` | `gfmodel` | `oem-glm-5-3-flash-prod-260827` |
| `kmodel` | `kmodel` | `kimi-k2.8-preview` | — | — | `global` | `kmodel` | `oem-kimi-k2.8-2026-09-11` |
| `kmodel_latest` | `kmodel_latest` | `kimi-k3.1-pro` | — | — | `global` | `kmodel_latest` | `oem-kimi-k3.1-2026-10-23` |
| `lite` | `lite` | `qwen3.7-plus` | `qwen3.7-plus` | — | `global` | `lite` | `bailian-qwen3.7-plus-free-newgateay-260401` |
| `mmodel` | `mmodel` | `MiniMax-M3.1-Flash` | — | — | `global` | `mmodel` | `oem-minimax-m3.1-flash-2026-10-18-china` |
| `qmodel` | `qmodel` | `qwen3.7-plus` | `qwen3.7-plus` | — | `global` | `qmodel` | `bailian-qwen3.7-plus-newgateway-260602` |
| `qmodel_latest` | `qmodel_latest` | `qwen3.7-max` | `qwen3.7-max` | — | `global` | — | `bailian-qwen3.7-max-newgateway-260521` |
| `qmodel_38max` | `qmodel_38max` | `qwen3.8-max` | `qwen3.8-max` | — | `global` | `qmodel_38max` | `bailian-qwen3.8-max-newgateway-260803` |
| `qfmodel` | `qfmodel` | `qwen3.8-flash` | — | — | `global` | `qfmodel` | `bailian-qwen3.8-flash-20260826` |
| `smodel` | `azure-gpt6-astra` | `gpt-6-astra` | — | `code-lm-145` | `code-145-est-01` | `smodel` | `g6a-[code-lm-145]-global-code-145-est-01-sZTOhg==` |
| `cmodel` | `cmodel` | `claude-fable-5-1-cc` | `claude-fable-5-1` | `inner-model-routify` | `global` | `cmodel` | `a-f51-[inner-model-routify]-260806-W5XoKpMc` |

### 7.2 Quick reference — one line per model (field comma-separated)

```
auto               provider_model=deepseek-v4-flash, supply_region=global, model_level=auto, target=deepseek-v4-flash-qteam-new-260727
fast               provider_model=kimi-k2.7-code-highspeed, supply_model=kimi-k2.7-code-highspeed, supply_region=global, model_level=fast, target=oem-kimi-k2.7-code-highspeed-2026-6-13
performance         provider_model=gpt-5.5, supply_model=claude-sonnet-5,gpt-5.5,gpt-5.6-terra, supply_region=code-17-est-01, model_level=performance, target=g55-global-code-lm-17-code-17-est-01-QCQEz4wL
efficient          provider_model=qwen3.7-plus, supply_model=qwen3.7-plus, supply_region=global, target=bailian-qwen3.7-plus-newgateway-260602
ultimate            provider_model=gpt-6.1-sol, supply_model=gpt-6.1-sol, supply_account=code-lm-197, supply_region=code-197-est-01, model_level=ultimate, target=g61s-[code-lm-197]-global-code-197-est-01-93iPyw==
dmodel             provider_model=deepseek-v4-pro, supply_region=global, model_level=dmodel, target=oem-deepseek-v4-new-260727-1
dfmodel            provider_model=deepseek-v4-flash, supply_region=global, target=deepseek-v4-flash-qteam-new-260727
gmodel             provider_model=glm-5.3, supply_region=global, model_level=gmodel, target=oem-glm-5-3-prod-260813
gfmodel            provider_model=glm-5.3-flash, supply_region=global, model_level=gfmodel, target=oem-glm-5-3-flash-prod-260827
kmodel             provider_model=kimi-k2.8-preview, supply_region=global, model_level=kmodel, target=oem-kimi-k2.8-2026-09-11
kmodel_latest      provider_model=kimi-k3.1-pro, supply_region=global, model_level=kmodel_latest, target=oem-kimi-k3.1-2026-10-23
lite               provider_model=qwen3.7-plus, supply_model=qwen3.7-plus, supply_region=global, model_level=lite, target=bailian-qwen3.7-plus-free-newgateay-260401
mmodel             provider_model=MiniMax-M3.1-Flash, supply_region=global, model_level=mmodel, target=oem-minimax-m3.1-flash-2026-10-18-china
qmodel             provider_model=qwen3.7-plus, supply_model=qwen3.7-plus, supply_region=global, model_level=qmodel, target=bailian-qwen3.7-plus-newgateway-260602
qmodel_latest      provider_model=qwen3.7-max, supply_model=qwen3.7-max, supply_region=global, target=bailian-qwen3.7-max-newgateway-260521
qmodel_38max       provider_model=qwen3.8-max, supply_model=qwen3.8-max, supply_region=global, model_level=qmodel_38max, target=bailian-qwen3.8-max-newgateway-260803
qfmodel            provider_model=qwen3.8-flash, supply_region=global, model_level=qfmodel, target=bailian-qwen3.8-flash-20260826
smodel             provider_model=gpt-6-astra, supply_account=code-lm-145, supply_region=code-145-est-01, model_level=smodel, target=g6a-[code-lm-145]-global-code-145-est-01-sZTOhg==
cmodel             provider_model=claude-fable-5-1-cc, supply_model=claude-fable-5-1, supply_account=inner-model-routify, supply_region=global, model_level=cmodel, target=a-f51-[inner-model-routify]-260806-W5XoKpMc
```

### 7.3 Reading the `target` (routing/profile fallback)

The `target` string is the upstream routing profile behind the roster key — the
"fallback" that actually served the turn:

- `bailian-…` → Alibaba Bailian Qwen (all `qwen*` rows + `lite`/`efficient`).
- `oem-…` → OEM/white-label supply (DeepSeek, GLM, Kimi, MiniMax).
- `g6a-[…]-…`, `g61s-[…]-…`, `g56t-[…]-…`, `g55-…` → Azure-hosted GPT
  profiles (Sonus / Ultimate / Performance).
- `a-f51-[inner-model-routify]-…` → Claude fable 5.1 routed through a profile.
- `supply_account` / `supply_region` appear only on routed profiles (Sonus,
  Ultimate, Performance, Cantus) — the infra that actually served the turn.

### 7.4 Observations

1. **`raw_usage` is intermittent.** A first probe of `auto`, `performance`,
   `efficient`, `kmodel`, `kmodel_latest` sometimes returns no
   `providerMetadata`; a re-probe returns it. Missing `providerMetadata` =
   "not captured this run", not "absent".
2. **Slots rotate their backing model.** `fast` was `deepseek-v4-flash`
   (morning) then `kimi-k2.7-code-highspeed` (evening); `performance`
   flip-flops between `gpt-5.6-terra` and `gpt-5.5` (region `code-4-est-01`
   ↔ `code-17-est-01`) across captures — sometimes `gpt-5.6-terra`, sometimes
   `gpt-5.5`. Never hard-code a slot's model.
3. **Fields themselves are intermittent too** (`supply_model`/`model_level`/
   `target` occasionally absent on a row that had them on another run —
   e.g. `dfmodel`/`efficient`/`qmodel_latest` showed no `model_level` in the
   evening capture).
4. `qfmodel` has a `target` (`bailian-qwen3.8-flash-20260826`) but it can be
   absent on a run.
5. **The Azure-hosted GPT slots are multi-supplier (operator-confirmed,
   2026-11-11).** `performance` also supplies **Claude Sonnet 5.5**
   (visible in its `supply_model=claude-sonnet-5,gpt-5.5,gpt-5.6-terra`);
   `ultimate` also supplies **Claude Opus 5.5** alongside GPT-6.1 Sol, and
   the 6.1 Sol slot has a GPT-5.6 Sol variant in rotation. The measured
   self-claims for these slots ("ChatGPT") reflect whichever GPT profile
   served that turn; the Claude suppliers answer as Claude on the wire.
6. **GLM slots fall back to Qwen 3 Max (operator-confirmed, 2026-11-11).**
   When the GLM backend is unavailable, `gmodel`/`gfmodel` route to Qwen
   3 Max (`qwen3.7-max`/`qwen3.8-max` class) instead of failing — the slot
   keeps answering, but the identity changes to Qwen. Treat an absent GLM
   self-claim (or a Qwen claim on a GLM key) as a fallback signal, not a
   slot misconfiguration.

### 7.5 The 406 trap: cmodel + identity prompt

- `cmodel` (Cantus) + the probe's default identity prompt
  (`"What model are you, and what is your knowledge cutoff date? Answer in
  one sentence."`) → `406 Upstream error [stream]` on gRPC.
- Same request **succeeds on the IDE surface** (HTTP 200), but the sample
  comes back empty. On gRPC it hard-fails with 406; on the IDE surface the
  upstream *swallows* the model's answer — the response has `ok: true` but
  no sample text. Both are the same upstream guardrail in two modes.
- A **greeting that asserts a wrong identity** — `"halo gpt"` — works on both
  surfaces and returns a sample **and** the model corrects us on its own
  (*"saya Claude, asisten AI buatan Anthropic—bukan GPT"* — "I'm Claude, an AI
  assistant made by Anthropic — not GPT", the model's verbatim reply). Verified **3/3 runs** (2026-11-04). This is the probe's replacement
  prompt for `cmodel`.
- **No phrasing trick that *asks* an identity question unlocks the answer**
  (verified live 2026-11-04, 20+ variants on the IDE surface). Literal
  questions (`What model are you?`), knowledge-cutoff, and every indirect
  self-claim phrasing tried — job-interview framing, "what would you call
  yourself", "what family/version are you", "what distinguishes you from
  your predecessor", Indonesian interrogatives (`kamu gpt kan?`,
  `perkenalkan dirimu`, `gimana ceritanya?`, quoted test prompts kept verbatim)
  — all return HTTP 200 with an **empty sample**. Only prompts that *assert*
  (never ask) identity return text. The upstream guardrail is content-based
  (any identity *request* triggers it), not prompt shape — but it does not
  block identity *assertions*.
- Other models accept the identity prompt on gRPC fine — only `cmodel`
  refuses it. Upstream-side guardrail, not a gateway bug. Workaround:
  `qoderCmodelProbePrompt` (assertion prompt `halo gpt`) in
  `src/providers/discovery/probe-phases.ts`.
- Note: the real identity still arrives reliably in `provider_metadata`
  (`provider_model=claude-fable-5-1-cc`, `supply_model=claude-fable-5-1`,
  `target=a-f51-[inner-model-routify]-…`) regardless of what the model
  says — the metadata is the trustworthy identity source, so the lost
  sample is not a gap for the probe feature.

### 7.6 Implementation map

| Layer | File | What |
| --- | --- | --- |
| Adapter capture | `src/providers/integrations/qoder/qoder.ts` | `collectQoderProviderMeta` reads `raw_usage` keys; terminal event carries `provider_metadata` |
| Probe default surface | `src/providers/discovery/probing-service.ts` | Qoder probes default to `surface: "ide"` |
| Probe result | `src/providers/discovery/discovery-types.ts` | `ProbeModelResult.providerMetadata` |
| Dashboard | `dashboard/src/features/provider-detail/sections/Models.tsx` | Qoder card tests use the console probe; metadata renders one-line + `(show more)` |
| cmodel prompt workaround | `src/providers/discovery/probe-phases.ts` | `qoderCmodelProbePrompt` |

---

## 8. Conclusions for the Adapter

_Synthesis of [20] §5 (2026-11-05) + [7] §4 (2026-11-04)._

1. **IDE/HTTP = the safest surface for PROBES** — 100% stable for all
   models & cases, including `tool_choice=required` (fully supported). This is
   why probes before Provider Detail use IDE — **not** the production
   transport (production: gRPC default, COSY free/lite).
2. **gRPC tools need precise proto shapes** — full `parameters` Struct,
   `description`/`strict` wrappers, `tool_choice` `{stringValue}`.
3. **gRPC does not support `tool_choice=required`** → omit the field (already
   implemented), rely on a neutral prompt. Do not fall back to IDE for this —
   IDE is not the production transport.
4. **Do not hard-code slot → model** — slots rotate their backing (e.g. `fast`
   changed from `deepseek-v4-flash` to `kimi-k2.7-code-highspeed`) and
   `raw_usage` is intermittent; `provider_metadata` is the trusted identity
   source, not the model's text.
5. **Reasoning models (e.g. `cmodel`) are sensitive to coercive prompts** →
   avoid words like "WAJIB" ("MANDATORY") / "don't answer in text"; use a
   neutral request (`qoderCmodelProbePrompt` for the identity probe).
6. **gRPC timeout ≥120s** for large/slow streams (60s → `Cancelled on client`).
7. **The tool-call delta pattern is the same on IDE & gRPC** (after unwrapping `fromProtoStruct`).
8. **No gRPC → IDE fallback.** IDE is probe-only. When gRPC rejects tools
   (400/406, e.g. `cmodel`/`mmodel`/`tools_required`), the only alternative
   path is COSY for free-tier rows — billed rows have no workaround other than
   a neutral prompt.

---

*Script: `model-matrix.ts` / `matrix-summary.ts`. Sandbox:
`D:\tmp\qoder-sandbox\results\` (`matrix-full-150-120s-…jsonl` final; earlier
runs are kept for comparison). Roster metadata via console
probe `POST /console/api/providers/qoder/models/probe` + dashboard model cards,
2026-11-04.*
