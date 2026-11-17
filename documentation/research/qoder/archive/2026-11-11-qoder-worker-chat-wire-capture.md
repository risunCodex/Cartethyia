# Qoder App 0.5.7 — Chat wire capture (worker, live 2026-11-11)

Capture method: Qoder app launched with `--host-resolver-rules` + mitmproxy
(8080) + `NODE_TLS_REJECT_UNAUTHORIZED=0`; worker then honored `HTTPS_PROXY`
(`source=environment`) and the full chat request was captured. This is the
**first complete worker chat capture** (headers + body pipeline).

## Request

```
POST /algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1
Host: api2.qoder.sh
Accept: text/event-stream
Authorization: Bearer COSY.<payload>.<signature>
Cache-Control: no-cache
Content-Type: application/json
Cosy-Business-Product: app
Cosy-Business-Type: agent
Cosy-ClientType: 10
Cosy-Data-Policy: agree
Cosy-Date: <epoch>
Cosy-Key: <RSA PKCS1 AES-128 key>
Cosy-MachineId: <uuid>
Cosy-MachineToken: P1gA… (UMID)
Cosy-MachineType: <18 hex>
Cosy-MachineOS: x86_64_win32
Cosy-MachineHostname: <real hostname>
Cosy-Scene: app
Cosy-User: <userId>
Cosy-Version: 1.1.79-hotfix.19
Login-Version: v2
X-Model-Key: <roster key>            # e.g. qmodel_latest
X-Model-Source: system
traceparent: 00-<traceid>-<spanid>-01   # W3C trace context
accept-language: *
sec-fetch-mode: cors
User-Agent: undici
Accept-Encoding: br, gzip, deflate
Content-Encoding: zstd               # body compressed with zstd
Content-Length: 77983 (zstd)
```

## Body pipeline (captured)

1. Raw HTTP body = zstd (magic `28 b5 2f fd`), 77983 bytes → decompress 218076 bytes.
2. Decompressed = `transformQoderBody` output (Qoder alphabet-scramble, same as gateway).
3. Reverse transform + base64 → 163555 bytes, mostly readable UTF-8 (system prompt, MCP tools).
4. Decoded content is the **agent system prompt** (browser-use MCP tools, tool-calling
   instructions, knowledge/wiki context) — the worker sends a large structured body,
   not a plain minimal chat payload.

## Worker environment/network facts (proven this session)

| Fact | Value |
|---|---|
| Worker process | `Qoder.exe … qoder-worker-runtime.obf.mjs --sdk` (Electron-hosted, Node/undici) |
| Proxy resolution | `mode=sdk, source=environment` when `HTTPS_PROXY` set at launch |
| Default | `environment-not-configured` → direct, HTTPDNS (Aliyun) |
| HTTPDNS | `networkMode=httpdns`, resolve api2 → `8.215.6.232` / `147.139.197.248` |
| TLS CA mode | `mode=explicit-system` (Windows store); rejects mitm unless node |
| Bypass for capture | `NODE_TLS_REJECT_UNAUTHORIZED=0` env at launch |
| Auth | OAuth `dt-` account → `Cosy-User` (userId), machine identity UMID |

> **User-Agent disambiguation (sering salah sangka).** `Bun/1.4.2` is the
> UA of the **qoder CLI** (`qodercli`, bun-compiled) and of the gateway's
> CLI/device-flow surfaces. `undici` is the UA of the **app/worker**
> (Electron-hosted Node `qoder-worker-runtime.obf.mjs --sdk`, undici fetch).
> The gateway's COSY chat surface mirrors the app wire (2026-11-11), so chat
> sends `undici` + `Accept-Encoding: br, gzip, deflate` + a zstd body;
> `Bun/1.4.2` belongs to the CLI surface.

## Diff vs gateway adapter (after 2026-11-11 alignment)

Full 32-row table (capture 2026-11-11):

| # | Atribut | Worker asli (capture) | Adapter (aligned) | Verdict |
|---|---|---|---|---|
| 1 | Method | `POST` | `POST` | ✅ MATCH |
| 2 | Path | `/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1` | sama | ✅ MATCH |
| 3 | Host | `api2.qoder.sh` | api1/api2/api3 | ✅ MATCH |
| 4 | `Accept` | `text/event-stream` | sama | ✅ MATCH |
| 5 | `Authorization` | `Bearer COSY.<payload>.<sig>` | sama | ✅ MATCH |
| 6 | `Cache-Control` | `no-cache` | sama | ✅ MATCH |
| 7 | `Content-Type` | `application/json` | sama | ✅ MATCH |
| 8 | `Cosy-Business-Product` | `app` | `app` | ✅ MATCH |
| 9 | `Cosy-Business-Type` | `agent` | `agent` | ✅ MATCH |
| 10 | `Cosy-ClientType` | `10` | `10` | ✅ MATCH |
| 11 | `Cosy-Data-Policy` | `agree` | `agree` | ✅ MATCH |
| 12 | `Cosy-Date` | epoch | epoch | ✅ MATCH |
| 13 | `Cosy-Key` | RSA PKCS1 AES-128 | sama | ✅ MATCH |
| 14 | `Cosy-MachineId` | UUID | UUID | ✅ MATCH |
| 15 | `Cosy-MachineToken` | `P1gA…` (UMID) | UMID kalau ada | ✅ MATCH* |
| 16 | `Cosy-MachineType` | 18-hex | 18-hex kalau ada | ✅ MATCH* |
| 17 | `Cosy-MachineOS` | `x86_64_win32` | `qoderMachineOs()` | ✅ MATCH |
| 18 | `Cosy-MachineHostname` | `RisunAgent` (asli) | sanitized | ✅ MATCH |
| 19 | `Cosy-Scene` | `app` | `app` | ✅ MATCH |
| 20 | `Cosy-User` | userId OAuth | userId | ✅ MATCH |
| 21 | `Cosy-Version` | `1.1.79-hotfix.19` | `getQoderVersion()` | ⚠️ beda versi |
| 22 | `Login-Version` | `v2` | `v2` | ✅ MATCH |
| 23 | `X-Model-Key` | `qmodel_latest` | roster key | ✅ MATCH |
| 24 | `X-Model-Source` | `system` | `system` | ✅ MATCH |
| 25 | `traceparent` | `00-…-01` (W3C) | `00-…-01` (W3C) | ✅ MATCH |
| 26 | `accept-language` | `*` | `*` | ✅ MATCH |
| 27 | `sec-fetch-mode` | `cors` | `cors` | ✅ MATCH |
| 28 | `User-Agent` | `undici` | `undici` | ✅ MATCH |
| 29 | `Accept-Encoding` | `br, gzip, deflate` | `br, gzip, deflate` | ✅ MATCH |
| 30 | `Content-Encoding` | `zstd` | `zstd` | ✅ MATCH |
| 31 | `Content-Length` | 77983 (zstd) | dynamic | ✅ |
| 32 | Body pipeline | `transformQoderBody` → `zstd` | `transformQoderBody` → `zstd` | ✅ MATCH |

Aligned 2026-11-11: `Cosy-Business-Product: app`, `Cosy-ClientType: 10`,
`Cosy-Scene: app`, `User-Agent: undici`, `Accept-Encoding: br,gzip,deflate`,
`Content-Encoding: zstd` (body zstd-compressed over the scrambled transform),
`traceparent`, `sec-fetch-mode: cors`, `accept-language: *`. Residual drift is
cosmetic only: `Cosy-Version` is the gateway's own `getQoderVersion()` (the
IDE-build fallback, verified accepted 19/19) rather than the worker's
`1.1.79-hotfix.19`, and the gateway sends `x-request-id`/`cosy-bodyhash`/
`cosy-bodylength`/`cosy-sigpath` extra headers the app capture does not show
(harmless superset).

**Signature pipeline (proven live 2026-11-11).** The COSY `signature` and
`cosy-bodyhash` are computed over the **scrambled** transform, *before* zstd
compression; the wire carries the zstd body. Signing over the zstd wire bytes
returns `403 Signature invalid` — the server decompresses before verifying.
Pipeline: `transformQoderBody` → sign (scrambled) → zstd compress → send.

## Files

- Raw zstd body: `C:/Users/Aria/AppData/Local/Temp/opencode/chat-body.zstd`
- Decompressed (untransformed partial): `…/chat-body-FINAL.json` (154526 chars)
- Scratch flows: `D:/tmp/mitm-qoder/flows/flows.jsonl`
