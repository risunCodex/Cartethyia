# Qoder — Model Matrix & Roster Metadata (konsolidasi 2026-11-05)

**Konsolidasi dari:**
[`2026-11-05-qoder-model-matrix-pass.md`](2026-11-05-qoder-model-matrix-pass.md) (final 150/150) ·
[`2026-11-05-qoder-model-matrix.md`](2026-11-05-qoder-model-matrix.md) (snapshot awal 139/150) ·
[`2026-11-04-qoder-probe-provider-metadata.md`](../qoder/2026-11-04-qoder-probe-provider-metadata.md) (roster metadata `raw_usage`).

> Konteks dari riset Qoder 2026-11-04 s/d 2026-11-05. Tanggal sumber
> dipertahankan per section. Tabel & blok kode dijaga verbatim.

## Daftar Isi
- [1. Hasil Final — 150/150](#1-hasil-final--150150)
- [2. Snapshot Awal — 139/150 (sebelum fix)](#2-snapshot-awal--139150-sebelum-fix)
- [3. Per Model — 15 roster key](#3-per-model--15-roster-key)
- [4. Per Surface & Per Case](#4-per-surface--per-case)
- [5. Error Patterns & Ukuran/Speed](#5-error-patterns--ukuran-speed)
- [6. Temuan Tool Calling](#6-temuan-tool-calling)
- [7. Roster Metadata — `raw_usage` (supply model / region / target)](#7-roster-metadata--raw_usage-supply-model--region--target)
- [8. Kesimpulan untuk Adapter](#8-kesimpulan-untuk-adapter)

---

## 1. Hasil Final — 150/150

_Sumber: [`2026-11-05-qoder-model-matrix-pass.md`](2026-11-05-qoder-model-matrix-pass.md) (2026-11-05)._

**Metode:** `model-matrix.ts` — 15 model × 2 surface (ide, grpc) × 5 case
= 150 run. OAuth `dt-`. Concurrency 5, timeout 120s.
**Hasil (final):** `D:\tmp\qoder-sandbox\results\matrix-full-150-120s-2026-11-04T22-12-43-176Z.jsonl`

### 1.1 Ringkasan (150/150, IDE 75/75, gRPC 75/75)

| | Jumlah |
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

**Semua 15 model: 10/10** — termasuk `cmodel`, `mmodel`, `smodel`,
`gmodel`, `qfmodel`, `qmodel_38max`, `dmodel`, `dfmodel` yang sempat gagal di
gRPC tools.

### 1.4 Perjalanan Fix (dari worker unpacked + live tests)

| Masalah | Sebelum | Sesudah | Sumber |
|---|---|---|
| gRPC tools `parameters` | `{fields:{}}` kosong | full Struct (`structOf`/`SBA`/`Lat`) | worker `byl`/`SBA` |
| gRPC tool `description` | tidak ada | `{value: desc}` (StringValue) | worker `xG` |
| gRPC tool `strict` | tidak ada | `{value: bool}` (BoolValue) | worker `Uat` |
| gRPC `tool_choice` | `{structValue:{fields:{type}}}` | `{stringValue:"auto"}` | worker `Lat` |
| gRPC `tool_choice=required` | `{stringValue:"required"}` / Struct | di-omit (gRPC tolak required) | upstream reject 400/406/422 |
| `cmodel` (Cantus) required | prompt koersif ("WAJIB…") → 406 `intention_rejected` | prompt netral non-koersif → tool dipanggil | guardrail model (safety) |
| flaky timeout (qmodel_38max/grpc/plain) | timeout 60s → `Cancelled on client` | timeout 120s → pass | stream lambat saat concurrency |

Catatan penting: 406 pada `cmodel` **bukan** ketidakmampuan model memakai
tools (tools biasa jalan) — melainkan guardrail menolak prompt yang bersifat
paksaan/koersif. Prompt netral menyelesaikannya.

---

## 2. Snapshot Awal — 139/150 (sebelum fix)

_Sumber: [`2026-11-05-qoder-model-matrix.md`](2026-11-05-qoder-model-matrix.md) (2026-11-05) — snapshot pra-fix; riwayat kegagalan._

**Metode:** `model-matrix.ts` — 15 model roster (1.1.83) × 2 surface (IDE/HTTP
`/model/v1`, gRPC `ChatService`) × 5 case (plain, tools, tools_none,
tools_required, parallel) = **150 run**. OAuth `dt-`, concurrency 5,
timeout 60s, non-blocking.
**Hasil:** `D:\tmp\qoder-sandbox\results\matrix-full-2026-11-04T21-54-29-466Z.jsonl`

### 2.1 Ringkasan snapshot (139/150; IDE 75/75; gRPC 64/75)

| | Jumlah |
|---|---|
| Total | 150 |
| OK | **139 (92.7%)** |
| Fail | 11 |
| IDE/HTTP | 75/75 OK (**100%**) |
| gRPC | 64/75 OK (85.3%) |

### 2.2 Per Model (awal)

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

Model bermasalah: **cmodel** (4 fail) & **mmodel** (4 fail) — semua di gRPC tools.

### 2.3 Per Surface

| Surface | OK | toolsCalled |
|---|---|
| ide | 75/75 | 42 |
| grpc | 64/75 | 34 |

**IDE/HTTP = 100% stabil.** gRPC gagal khusus di case tools tertentu.

### 2.4 Per Case

| Case | OK | toolsCalled | Catatan |
|---|---|---|
| plain | 30/30 | 0 | ✅ semua |
| tools | 28/30 | 26 | 2 fail (gRPC: cmodel, mmodel) |
| parallel | 28/30 | 28 | 2 fail (gRPC: cmodel, mmodel) |
| tools_none | 28/30 | **2** | 2 fail; hanya 2 model tetap panggil tools walau none |
| tools_required | 25/30 | 20 | **5 fail** — paling bermasalah |

### 2.5 Error Patterns

| Error | Jumlah | Terjadi di |
|---|---|---|
| `grpc-status=13 Stream error: 400` | 10 | gRPC tools: cmodel (tools/none/parallel), mmodel (tools/none/parallel/required), dmodel/dfmodel/qmodel_38max (required) |
| `grpc-status=13 Stream error: 406` | 1 | cmodel/grpc/tools_required |

**Insight:**
- gRPC **menolak `tool_choice=required`** (400) untuk sebagian besar model
  (dmodel, dfmodel, qmodel_38max, mmodel, cmodel). `cmodel` dapat 406.
- gRPC menolak **tools biasa** untuk `cmodel` & `mmodel` (400) — model ini
  tidak kompatibel dengan tool-call di gRPC.
- **IDE menerima semua** — tidak ada satu pun fail di surface IDE.

### 2.6 Temuan Tool Calling (awal)

- `tools_none`: hanya **2/30** model yang tetap memanggil tool (kemungkinan
  `qfmodel`/`gfmodel`) — sisanya patuh pada `none`.
- `parallel`: 28/30 memanggil 2-4 tools (paralel berhasil).
- `tools_required`: 20/30 benar-benar memanggil tool; 5 gagal (gRPC), sisanya
  menjawab teks tanpa tool (intention rejected).

### 2.7 Ukuran/speed (sample)

| Model | Surface ms (median-ish) |
|---|---|
| dfmodel/ide | 1-2s (cepat) |
| dfmodel/grpc | 2-4s |
| kmodel_latest/grpc | 9-13s (lambat) |
| gfmodel/grpc/tools_none | 18s (paling lambat) |

---

## 3. Per Model — 15 roster key

_Sintesis [20] §3 vs [19] §2 (2026-11-05)._

Semua 15 roster key lulus **10/10** setelah fix (final). Perbandingan snapshot
awal vs final:

| Model | Awal OK | Final OK | Catatan |
|---|---|---|---|
| auto | 10/10 | 10/10 | — |
| ultimate | 10/10 | 10/10 | — |
| fast | 10/10 | 10/10 | — |
| efficient | 10/10 | 10/10 | — |
| smodel | 10/10 | 10/10 | — |
| **cmodel** | 6/10 | 10/10 | 4 fail awal (gRPC tools) + 406 guardrail |
| qmodel_38max | 9/10 | 10/10 | 1 fail awal (tools_required) |
| qfmodel | 10/10 | 10/10 | — |
| kmodel_latest | 10/10 | 10/10 | — |
| kmodel | 10/10 | 10/10 | — |
| gmodel | 10/10 | 10/10 | — |
| gfmodel | 10/10 | 10/10 | — |
| dmodel | 9/10 | 10/10 | 1 fail awal (tools_required) |
| dfmodel | 9/10 | 10/10 | 1 fail awal (tools_required) |
| **mmodel** | 6/10 | 10/10 | 4 fail awal (gRPC tools) |

---

## 4. Per Surface & Per Case

_Sintesis [20] vs [19] (2026-11-05)._

**Per surface:**

| Surface | Awal OK | Final OK |
|---|---|---|
| ide | 75/75 | 75/75 |
| grpc | 64/75 | 75/75 |

**Per case:**

| Case | Awal OK | Final OK | toolsCalled (final) |
|---|---|---|---|
| plain | 30/30 | 30/30 | 0 |
| tools | 28/30 | 30/30 | 29 |
| parallel | 28/30 | 30/30 | 30 |
| tools_none | 28/30 | 30/30 | 5 |
| tools_required | 25/30 | 30/30 | 26 |

---

## 5. Error Patterns & Ukuran/Speed

_Riwayat snapshot [19] §5 + §7 (2026-11-05); final sudah 0 fail._

**Error patterns (awal):**

| Error | Jumlah | Terjadi di |
|---|---|---|
| `grpc-status=13 Stream error: 400` | 10 | gRPC tools: cmodel (tools/none/parallel), mmodel (tools/none/parallel/required), dmodel/dfmodel/qmodel_38max (required) |
| `grpc-status=13 Stream error: 406` | 1 | cmodel/grpc/tools_required |

**Ukuran/speed (sample, awal):**

| Model | Surface ms (median-ish) |
|---|---|
| dfmodel/ide | 1-2s (cepat) |
| dfmodel/grpc | 2-4s |
| kmodel_latest/grpc | 9-13s (lambat) |
| gfmodel/grpc/tools_none | 18s (paling lambat) |

> Setelah fix: **0 fail** di semua surface/case — error gRPC 400/406 tidak
> lagi muncul; timeout naik 60s → 120s untuk stream besar/lambat.

---

## 6. Temuan Tool Calling

_Sintesis [19] §6 (awal) + [20] §2/§3 (final) — 2026-11-05._

- `tools_none`: awal hanya **2/30** yang tetap memanggil tool; final
  **5/30** (`toolsCalled=5`) — mayoritas patuh pada `none`.
- `parallel`: awal 28/30 → final **30/30**; 2-4 tools dipanggil paralel.
- `tools_required`: awal 20/30 benar-benar memanggil tool (5 gagal di gRPC,
  sisanya menjawab teks tanpa tool); final **26/30** memanggil tool.
- Pola delta tool-call sama di IDE & gRPC (setelah unwrap
  `fromProtoStruct`).
- Fix gRPC tools: `parameters` Struct penuh (`structOf`/`SBA`/`Lat`),
  `description`/`strict` wrapper (`StringValue`/`BoolValue`),
  `tool_choice` `{stringValue:"auto"}`; omit `required` (gRPC tolak).

---

## 7. Roster Metadata — `raw_usage` (supply model / region / target)

_Sumber: [`2026-11-04-qoder-probe-provider-metadata.md`](../qoder/2026-11-04-qoder-probe-provider-metadata.md) (2026-11-04)._

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

### 7.5 The 406 trap: cmodel + identity prompt

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

### 7.6 Implementation map

| Layer | File | What |
| --- | --- | --- |
| Adapter capture | `src/providers/integrations/qoder/qoder.ts` | `collectQoderProviderMeta` reads `raw_usage` keys; terminal event carries `provider_metadata` |
| Probe default surface | `src/providers/discovery/probing-service.ts` | Qoder probes default to `surface: "ide"` |
| Probe result | `src/providers/discovery/discovery-types.ts` | `ProbeModelResult.providerMetadata` |
| Dashboard | `dashboard/src/features/provider-detail/sections/Models.tsx` | Qoder card tests use the console probe; metadata renders one-line + `(show more)` |
| cmodel prompt workaround | `src/providers/discovery/probe-phases.ts` | `qoderCmodelProbePrompt` |

---

## 8. Kesimpulan untuk Adapter

_Sintesis [20] §5 (2026-11-05) + [7] §4 (2026-11-04)._

1. **IDE/HTTP = surface paling aman** — 100% stabil untuk semua model & case,
   termasuk `tool_choice=required` (didukung penuh).
2. **gRPC tools butuh bentuk proto presisi** — `parameters` Struct penuh,
   `description`/`strict` wrapper, `tool_choice` `{stringValue}`.
3. **`tool_choice=required` tidak didukung gRPC** → omit field, andalkan prompt
   (netral, non-koersif); atau fallback ke IDE.
4. **Jangan hard-code slot → model** — slots rotate backing-nya (mis. `fast`
   ganti dari `deepseek-v4-flash` ke `kimi-k2.7-code-highspeed`) dan
   `raw_usage` intermittent; `provider_metadata` adalah sumber identitas
   terpercaya, bukan teks model.
5. **Model reasoning (mis. `cmodel`) sensitif terhadap prompt paksaan** →
   hindari kata "WAJIB"/"jangan jawab teks"; pakai permintaan netral
   (`qoderCmodelProbePrompt` untuk probe identity).
6. **Timeout gRPC ≥120s** untuk stream besar/lambat (60s → `Cancelled on client`).
7. **Pola delta tool-call sama di IDE & gRPC** (setelah unwrap `fromProtoStruct`).
8. **Fallback gRPC → IDE** saat model menolak tools (400/406) — terutama
   `cmodel`, `mmodel`, dan case `tools_required`.

---

*Script: `model-matrix.ts` / `matrix-summary.ts`. Sandbox:
`D:\tmp\qoder-sandbox\results\` (`matrix-full-150-120s-…jsonl` final; run
sebelumnya tetap tersimpan untuk perbandingan). Roster metadata via console
probe `POST /console/api/providers/qoder/models/probe` + dashboard model cards,
2026-11-04.*
