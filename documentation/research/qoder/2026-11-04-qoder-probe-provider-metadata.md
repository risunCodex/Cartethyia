# Qoder probe: provider metadata (raw_usage) — full roster capture

Live capture of the provider metadata the IDE surface (`/model/v1`) echoes in
its terminal `raw_usage` frame for every Qoder roster key. This is the trusted
source for "which model really served this turn": the production transports
(gRPC / COSY) echo only opaque roster keys (`auto`, `lite`, `cmodel`, …),
while the metadata below is the only place the upstream names its real supply
model, region, and target.

Captured via the console probe (`POST /console/api/providers/qoder/models/probe`,
backend defaults Qoder probes to the IDE surface) and the dashboard model cards,
2026-11-04.

---

## Full roster — verified live

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

## Quick reference — one line per model (field comma-separated)

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

## Reading the `target` (routing/profile fallback)

The `target` string is the upstream routing profile behind the roster key — the
"fallback" that actually served the turn:

- `bailian-…` → Alibaba Bailian Qwen (all `qwen*` rows + `lite`/`efficient`).
- `oem-…` → OEM/white-label supply (DeepSeek, GLM, Kimi, MiniMax).
- `g6a-[…]-…`, `g61s-[…]-…`, `g56t-[…]-…`, `g55-…` → Azure-hosted GPT
  profiles (Sonus / Ultimate / Performance).
- `a-f51-[inner-model-routify]-…` → Claude fable 5.1 routed through a profile.
- `supply_account` / `supply_region` appear only on routed profiles (Sonus,
  Ultimate, Performance, Cantus) — the infra that actually served the turn.

## Observations

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

## The 406 trap: cmodel + identity prompt

- `cmodel` (Cantus) + the probe's default identity prompt
  (`"What model are you, and what is your knowledge cutoff date? Answer in
  one sentence."`) → `406 Upstream error [stream]` on gRPC.
- Same request **succeeds on the IDE surface** (HTTP 200), but the sample
  comes back empty. On gRPC it hard-fails with 406; on the IDE surface the
  upstream *swallows* the model's answer — the response has `ok: true` but
  no sample text. Both are the same upstream guardrail in two modes.
- A **sapaan yang meng-assert identitas salah** — `"halo gpt"` — works on both
  surfaces and returns a sample **and** the model corrects us on its own
  (*"saya Claude, asisten AI buatan Anthropic—bukan GPT"*). Verified
  **3/3 runs** (2026-11-04). This is the probe's replacement prompt for
  `cmodel`.
- **No phrasing trick that *asks* an identity question unlocks the answer**
  (verified live 2026-11-04, 20+ variants on the IDE surface). Literal
  questions (`What model are you?`), knowledge-cutoff, and every indirect
  self-claim phrasing tried — job-interview framing, "what would you call
  yourself", "what family/version are you", "what distinguishes you from
  your predecessor", Indonesian interrogatives (`kamu gpt kan?`,
  `perkenalkan dirimu`, `gimana ceritanya?`) — all return HTTP 200 with an
  **empty sample**. Only prompts that *assert* (never ask) identity return
  text. The upstream guardrail is content-based (any identity *request*
  triggers it), not prompt shape — but it does not block identity
  *assertions*.
- Other models accept the identity prompt on gRPC fine — only `cmodel`
  refuses it. Upstream-side guardrail, not a gateway bug. Workaround:
  `qoderCmodelProbePrompt` (assertion prompt `halo gpt`) in
  `src/providers/discovery/probe-phases.ts`.
- Note: the real identity still arrives reliably in `provider_metadata`
  (`provider_model=claude-fable-5-1-cc`, `supply_model=claude-fable-5-1`,
  `target=a-f51-[inner-model-routify]-…`) regardless of what the model
  says — the metadata is the trustworthy identity source, so the lost
  sample is not a gap for the probe feature.

## Implementation map

| Layer | File | What |
| --- | --- | --- |
| Adapter capture | `src/providers/integrations/qoder/qoder.ts` | `collectQoderProviderMeta` reads `raw_usage` keys; terminal event carries `provider_metadata` |
| Probe default surface | `src/providers/discovery/probing-service.ts` | Qoder probes default to `surface: "ide"` |
| Probe result | `src/providers/discovery/discovery-types.ts` | `ProbeModelResult.providerMetadata` |
| Dashboard | `dashboard/src/features/provider-detail/sections/Models.tsx` | Qoder card tests use the console probe; metadata renders one-line + `(show more)` |
| cmodel prompt workaround | `src/providers/discovery/probe-phases.ts` | `qoderCmodelProbePrompt` |
