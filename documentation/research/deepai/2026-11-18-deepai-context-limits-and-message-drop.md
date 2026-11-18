# DeepAI Code — context limits, lane headers, and the message-drop patch (2026-11-18)

Follow-up to the 0.3.35 unpack audit and the 0.3.40 bundle inspection. All probes
were raw `fetch` calls to `https://api.deepai.org/deepai_code/chat/completions`
with the account `Api-Key`; no harness involved unless stated otherwise.
Credentials came from a local accounts export and were never printed.

## Request shape (verified against `binCli-D_ZLjpIS.mjs` @ 0.3.40)

The desktop/CLI runs a loopback model transport that forwards the pi-harness
OpenAI body **verbatim** upstream:

```
POST https://api.deepai.org/deepai_code/chat/completions
X-DeepAI-Code-Theos: 7            # lane version; 4 also accepted (both 200)
X-DeepAI-Code-Instance: <32 hex>  # random per process
X-DeepAI-Code-Machine: <sha256>   # sha256(machine-id); see detect() in bundle
api-key: <api_key>                # lowercase header spelling on the wire
X-Session-Affinity: <optional>
```

`X-DeepAI-Code-Machine` is `sha256` of IOPlatformUUID (macOS), SMBIOS UUID /
MachineGuid (Windows), or `/etc/machine-id` (Linux). Omitting it does **not**
change observed behavior on the free lane — lane 7 with and without the header
produced identical `prompt_tokens` on the 10×90k probe.

## Findings

| Probe | Result |
| --- | --- |
| 1 message, 50k–110k chars | counted honestly (~5.3 chars/token), canary reached |
| 1 message, 200k chars | **silently dropped**: `prompt_tokens=289`, mid-payload canary NOT reached, HTTP 200 "OK" |
| 10 messages × 90k chars (900k total) | `prompt_tokens≈33.7k` of ~170k honest — server retains only a fraction |
| `Content-Encoding: gzip` | HTTP 400 `invalid_request_error` — compression unsupported |
| Stream vs non-stream | identical truncation behavior |
| Lane Theos 4 vs 7, ± machine header | no difference on free account (`is_pro: false`) |

- **Per-message ceiling**: somewhere between 110k and 200k chars; 90k is the
  verified-safe chunk size. The drop is per message, not per request.
- **Effective retained context**: ~26–34k prompt tokens per call regardless of
  total payload size (observed via `usage` + `cached_tokens`). Catalog
  `contextWindow: 320_000` is the upstream model window, not what this lane
  serves. Whether pro accounts get a larger served window is untested.
- The pi harness never trips this because its own compaction fires at
  `contextWindow − reserveTokens(16384)` client-side first.

## Patch (this repo)

`DEEPAI_SPEC.prePayload` → `chunkDeepAIChatMessages()` splits any chat message
whose text content exceeds `DEEPAI_MAX_MESSAGE_CHARS = 90_000` into consecutive
same-role messages (string content sliced directly; array content split per
text part; `tool_calls` kept on the first chunk only). Responses-wire payloads
(`input`, not `messages`) are untouched. Lane version bumped 4 → 7.

Live verification through `createApiKeyAdapter(DEEPAI_SPEC)`: a 250k-char user
message previously surfaced as `input_tokens=289`; after the patch it reports
`input_tokens=26,828` — the leading ~27k tokens now reach the model instead of
vanishing. The ~34k total-retention ceiling remains an upstream limit.

Tests: `test/providers/deepai.test.ts` (18 pass).

## Open questions

- Exact per-message threshold between 110k–200k chars (not bisected).
- Whether the ~34k retention figure is a true server cap or a usage-reporting
  artifact — a per-chunk canary probe would settle it.
- Pro-lane serving window (`is_pro: true` account needed).
