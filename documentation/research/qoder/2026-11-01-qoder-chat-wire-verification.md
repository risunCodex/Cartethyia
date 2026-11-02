# Qoder chat wire verification — native plugin + QoderWake IDE surface (2026-11-01)

Merged note covering two independent audits of the Qoder chat wire: the
JetBrains plugin native binary vs the Cartethyia adapter (COSY Bearer path),
and the QoderWake IDE model-server surface (`/model/v1/chat/completions`) that
became the adapter's default chat path.

---

## Part A — Native plugin binary vs adapter (COSY Bearer)

Audit of the unpacked Qoder JetBrains plugin (product jar
`instrumented-qoder-product-2026.1030.84844323.jar`, native payload pinned
`qoder-2026.1030.1.zip`, commit `acc39d3`, built 2026-10-30 15:32:57)
against Cartethyia's `src/providers/integrations/qoder/qoder.ts`. Static
strings were extracted from the native `Qoder.exe` (x86_64) into
`D:\tmp\qoder-strings.txt` (713,985 entries) and filtered with Bun scripts.
No binaries were executed.

### A.1 Verified matches (adapter == native)

| Wire element | Evidence |
|---|---|
| Body alphabet transform | Alphabet string byte-identical in binary: `_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!` (line 560198) |
| COSY token shape | `Bearer COSY.%s.%s` (line 85969) — matches `qoderBuildCosyHeaders` `authorization` |
| Go static headers | `appcode`, `date`, `signature = md5(cosy&<b64secret>&<date>)` — matches `qoderStaticHeaders`; `Login-Version` present in binary (line 85783) |
| Client triplet | `"client_type":"%s","client_version":"%s","os":"%s"` (line 87157) — matches `client_type/client_version/os` JSON triplet |
| PAT exchange | `jobToken response missing id/securityOauthToken (id=%q token=%q)` (line 87338) — matches `exchangeQoderPat` shape check; `login_with_qoder_pat` (line 86183) |
| CN PAT path | `qodercn pat exchange server error: %s` (line 86909) — confirms CN PAT exchange exists (adapter uses `openapi/api/v1/jobToken/exchange`) |
| COSY Bearer scheme | Already verified live against `api2.qoder.sh` (see [credits/claims/identity](2026-10-29-qoder-credits-claims-identity.md)) — same scheme the chat adapter sends |

### A.2 Header delta — present in native, absent from chat adapter

| Header (binary) | Adapter chat request |
|---|---|
| `Cosy-ClientIp` (line 85783) | not sent |
| `X-Qoder-Routing-Policy-Id` (line 86516) | not sent |
| `X-Qoder-Remote-Protocol-Version` (line 86733) | not sent |
| `X-Model-Name` (line 85716) | adapter sends `x-model-key` / `x-model-source` instead (different name) |
| `Cosy-MachineCode` (line 85929) | only in `qoder-checkin` (UMID); not merged into chat dispatch |
| `Cosy-MachineHostname` (line 86179) | sent in chat dispatch (`qoder.ts:1152`, `qoderMachineHostname()`); also used by `qoder-checkin` |
| `Content-Length` | native sets it explicitly (`Content-Length: %v`, line 86306); adapter lets `fetch` set it — functionally equivalent |

Non-issue: native header casing is PascalCase (`Cosy-Key`, `Cosy-User`,
`Cosy-Date`); adapter sends lowercase. HTTP header names are case-insensitive,
and Go's client canonicalizes them, so this is cosmetic.

Adapter-only headers not visible in the native string pool: `cosy-bodyhash`,
`cosy-bodylength`, `cosy-sigpath`, `cosy-business-product/type/version`,
`cosy-scene`, `cosy-organization-tags`. These come from the COSY Bearer
implementation, which has been verified working against the live host; their
absence from the string pool is not evidence they are wrong (Go builds header
names and values from variables, so they may not appear as contiguous
literals).

### A.3 Signature schemes — two different paths

1. **COSY Bearer** (chat request, `qoderBuildCosyHeaders`): md5 chain over
   `payload \n cosyKey \n date \n body(latin1) \n sigPath`, RSA-encrypted AES
   key, `Bearer COSY.payload.sig`. This is the scheme the native client uses
   for `/algo` chat traffic and it is verified working.
2. **Gateway HMAC "Signature"** (non-chat endpoints, e.g. activity claim) —
   documented in [credits/claims/identity](2026-10-29-qoder-credits-claims-identity.md):
   `bodyHash = sha256(String(contentLength))` (hash of the *length string*),
   `sts = ${method} ${path} ${requestId} ${machineToken} ${ts} ${bodyHash}`,
   `sig = HMAC-SHA256(secret, sts)` where
   `secret = sha256("cosy:" + ideVersion + ":" + machineToken)`. This is a
   separate scheme from COSY Bearer and is not used by the chat adapter.

The earlier "signature hashes the content-length string" finding refers to the
gateway HMAC scheme, not to the COSY Bearer chat signer. The chat adapter is
correct to hash the raw body: that is what COSY Bearer does.

### A.4 machineId semantics

- **Native:** hardware-derived (`GetMachineId`, disk serial + MAC,
  `device info machineSerialNum is: device info diskSerialNumber is`), one per
  physical machine, stateless/token is a pure function of hardware.
- **Adapter:** OAuth path uses `auth_state.machineId` when present, else a
  per-account derived UUID (`sha256("qoder-machine-v1:" + accountId)`); PAT
  path mints a random UUID with a 1-hour TTL. This is an intentional deviation
  for pooling: pooled accounts keep one stable device fingerprint per account
  across restarts instead of looking like a new device every time, while
  staying distinct per account (established in
  [UMID/identity findings](2026-10-29-qoder-credits-claims-identity.md):
  daily-credit claim surface does not gate on genuine identity).

### A.5 Live probe results (2026-11-01, real OAuth account)

| Probe | Endpoint | Result |
|---|---|---|
| Plugin COSY, adapter's exact header set | `api2.qoder.sh/algo/.../agent_chat_generation` | **200 + streaming `choices[].delta.reasoning_…`** — chat works with the adapter's headers as-is |
| Plugin COSY + native-only headers (`Cosy-ClientIp`, `X-Qoder-Routing-Policy-Id`, `X-Qoder-Remote-Protocol-Version`) | same | **200 + streaming** — same behavior; those headers are not a prerequisite for chat (an earlier 103 duplicate was an upstream duplicate-guard on an identical record id, not a header rejection) |
| IDE modern path, plain `Bearer <dt-…>` + `X-Request-ID`/`X-Session-ID` | `api2-v2.qoder.sh/model/v1/chat/completions` | **200**, `event: error provider_error "All models failed"` — token accepted (no 401/403), but model-server surface failed at provider level with model `auto` |
| IDE modern path + `cosy-version`/`cosy-clienttype`/`cosy-machineos`/`cosy-machinetoken`/`cosy-machinetype` | same | same `provider_error "All models failed"` |

Key takeaways:

- The plugin's COSY Bearer chat path **works end-to-end with the adapter's
  current header set**; it streams real tokens.
- The three native-only headers do not affect chat acceptance — adding them
  changes nothing observable.
- The IDE surface authenticated the same `dt-` token as a plain Bearer, but the
  early "all models failed" probe was caused by sending the model as `auto`/a
  virtual name — upstream rejects unresolved virtual names (`invalid_model_error`)
  or falls back to `auto`. Sending a resolved roster key (e.g. `qfmodel`)
  streams immediately (see Part B).

---

## Part B — QoderWake IDE model-server surface

Reverse engineering of the QoderWake desktop app (macOS ARM64, v1.2.7, cf
`Info.plist` `CFBundleShortVersionString` 0.1.19 / `QoderWakeRuntimeVersion`
1.2.7 / native build 39, built 2026-10-29) and confirmation that the Qoder
"IDE surface" (`/model/v1/chat/completions`) is the correct chat path to use
instead of the legacy COSY surface.

### B.1 Artifacts

- Installer: `https://download.qoder.com/qoderwake/installers/latest/qoderwake_latest_darwin_arm64.dmg`
  (found via `qoder.com/en/download?product=qoderwake` page chunk 9774).
- Unpacked: `QoderWake.app/Contents/Resources/payload/` contains two bundled
  binaries: `qoderwake/qoderwake` (17 MB, daemon runtime) and
  `qodercli/qodercli-wake` (16 MB, bundled CLI runtime, version 1.1.76 per
  `installer-manifest.json`).
- `installer-manifest.json`: schema `qoderwake.nativeInstaller.v1`, product
  QoderWake, version 1.2.7, channels manifest at
  `https://download.qoder.com/qoderwake/channels/manifest.json`.
- `Info.plist`: daemon default port `19820`, deep-link scheme `qoder-wake`,
  runtime dir `.qoderwake`, bundle id `com.qoder.QoderWake.MenuBar`.

### B.2 Wire findings (from binary string extraction)

QoderWake uses the **same COSY Bearer scheme as the plugin** (from
`qoderwake` binary):

```js
// identity object → AES-128-CBC (random key) → base64 `info`
// payload = b64( sortedCompact({ version:"v1", requestId, info, cosyVersion, ideVersion:"") })
// signature = md5(payload \n cosyKey \n timestamp \n body \n path)
// Authorization: `Bearer <prefix>${payload}.${signature}`  // prefix resolved at runtime
{
  "Cosy-User": ...,
  "Cosy-Key": ...,
  "Cosy-Date": timestamp,
  Authorization: `Bearer ${payload}.${signature}`,
}
```

Plus static identity headers: `Content-Type, Accept, Accept-Encoding, Cosy-Version,
Cosy-MachineId, Cosy-MachineOS = ${process.platform}_${process.arch}, Cosy-ClientType,
Login-Version: "v2"`.

The bundled CLI (`qodercli-wake`) contains **both** chat surfaces:

| Surface | Path | Auth |
|---|---|---|
| Legacy COSY | `/algo/api/v2/service/pro/sse/agent_chat_generation` | COSY Bearer |
| IDE / model-server | `/model/v1/chat/completions` | plain `Bearer <dt-…>` |
| Model list | `/api/v2/model/list?Encode=1` | COSY signed GET |

### B.3 Live behavior (real `dt-` OAuth account)

| Probe | Result |
|---|---|
| Legacy COSY chat (`qfmodel`) | `200` but `10605 isQueued` — server-side queue, parks request with `retryAfterSeconds` |
| IDE `/model/v1` chat (`qfmodel`) | `200` stream, **immediate**: OpenAI chunks, `model:"qfmodel"` |
| IDE model validation | `qwen3.8-flash` (virtual name) → `invalid_model_error "Unsupported model"` — virtual names must be resolved to roster keys first |
| Model list | `200` signed GET, full `{"chat":[...]}` roster with `context_config`, `is_free`, `display_name` |

Key conclusions:

1. **Use the IDE surface for chat.** It streams immediately; the legacy COSY
   surface answers `10605 isQueued` and queues requests. The adapter default
   dispatch should be `/model/v1/chat/completions`.
2. **Model name in the response** is the roster key you send (`qfmodel`),
   not a display name. Sending an unresolved virtual name makes the upstream
   reject (`invalid_model_error`) or fall back to `auto`.
3. **QoderWake reuses the COSY scheme** for non-chat endpoints and the modern
   surface for chat; the Cartethyia signer (`qoderSignerFor`) already matches
   the COSY scheme 1:1.
4. **Live catalog corrections** (see `qoder-catalog.ts`):
   - `dfmodel` (DeepSeek-Flash) is **no longer free** (`is_free:false`).
   - `kmodel_latest` display is **Kimi-K3.1-Pro** (not "Kimi-K3").
   - `mmodel` display is **MiniMax-M3.1-Flash** (not "MiniMax-M3").
5. The IDE surface returns `usage:null` on chunks even with
   `stream_options.include_usage:true`; token usage must be obtained from the
   terminal `[DONE]` frame or a dedicated event if needed.

### B.4 Outcome — adapter migrated to the IDE surface (verified)

The adapter (`src/providers/integrations/qoder/qoder.ts`) now defaults chat
dispatch to the IDE surface (`/model/v1/chat/completions`). When that surface
answers an entitlement refusal (HTTP 402 / `{"code":116}`, seen on free-tier
accounts), dispatch falls back automatically to the legacy COSY surface
(`/algo/.../agent_chat_generation`), which streams with the same credential —
but only for a free-tier model row (`is_free: true`). For a billed model the
same 402/116 is genuine quota exhaustion (Qoder's daily exhaustion / cooldown
run on a 1-day cycle) and surfaces as-is, so the exhausted state is never
masked by a fallback. A 401/403/model error is surfaced as-is either way.
`surface: "cosy"` remains as an explicit force-legacy option. Live end-to-end
verification against a real `dt-` OAuth account:

- Streaming response completes: `Pong! 🏓` text + reasoning trace.
- `stop_reason` is now correctly `"stop"` (previously `none`). Two root
  causes were fixed:
  1. The IDE surface sends an empty string `finish_reason: ""` per delta,
     which was captured as a real finish reason and shadowed the terminal
     `[DONE]` frame. Empty strings are now treated as "no stop signal".
  2. `mapQoderFinishReason` did not map `"stop"` — it only knew `length`,
     `tool_calls`, `content_filter`. `"stop"` now maps to `stop`.
- Token usage is read from the terminal event's `raw_usage.data` (OpenAI
  shape: `prompt_tokens`/`completion_tokens` + details). `raw_usage` is not
  always sent; when absent, the terminal still synthesizes `stop`.
- `decodeSseEvents` (`src/protocol/sse-decoder.ts`) now treats a bare,
  non-SSE line after an open `data:` event as a continuation of that event
  instead of failing with "Malformed SSE line". This is required because the
  IDE surface emits one `data:` event whose JSON payload contains literal
  newlines (e.g. the terminal `raw_usage` event).

Full backend suite: 4006 pass / 0 fail / 1 skip (13.03s, 348 files).

---

## Evidence files

- `D:\tmp\qoder-jetbrains-unpacked\qoder-jetbrains\lib\instrumented-qoder-product-2026.1030.84844323.jar`
- `D:\tmp\Qoder.exe` (extracted native x86_64 binary, string source)
- `D:\tmp\qoder-strings.txt` (713,985 extracted strings)
- `D:\tmp\binaries-qoder-2026.1030.1.zip` (config.json/env.json)
- `D:\tmp\qoderwake_latest_darwin_arm64.dmg` (downloaded 2026-11-01)
- `D:\tmp\qoderwake-dmg\` (unpacked app)
- `D:\tmp\qoderwake-strings.txt` (553,784 strings from `qoderwake`)
- `D:\tmp\qodercli-wake-strings.txt` (611,719 strings from `qodercli-wake`)
