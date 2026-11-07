# Devin inline-image wire — live debugging, 2026-11-07

> **CORRECTION / FINAL VERDICT (same day, later pass):** the "FIXED" rows below
> are **retracted**. A paired control (red|blue vs green|yellow vs **no image
> at all**) showed `swe-1-6-slow` answers "cannot see" identically in every
> condition — the earlier `"Red blue"` was the model guessing from a prompt
> that said "two colors", not vision. `swe-2-flash-medium` rejects the image
> with `invalid_argument`. **Neither available model supports inline images.**
> The image code has been removed from the adapter, `vision` flags removed
> from the catalog, and a regression test now asserts `images` is NOT sent.
> Reproduce with `scripts/provider-probing/devin/devin-image-control.mjs`.
> The rest of this document is kept as the evidence trail, including the
> inference that turned out to be wrong.

Status: verified live, uncommitted. Skill: `cartethyia-reverse-engineering`
(principles applied: pin the build, read the `.proto` first, grep by
surrounding context, capture the real wire instead of guessing).

## Final paired control (the evidence that settled it)

Generated two distinct fixtures: red|blue (986 B) and green|yellow (989 B),
both valid 200×200 PNGs. Same prompt for every condition.

```
model / condition                     answer
1.6-slow / red|blue                   "I am unable to see the image provided, so I cannot identify the colors."
1.6-slow / green|yellow               "I cannot see the image."
1.6-slow / NO IMAGE (control)         "I cannot see the image you are referring to."
1.6-slow / green|yellow #2            "I cannot see the image to determine the colors."
1.6-slow / NO IMAGE #2                "I do not know. No image was provided."
2-flash  / red|blue                   invalid_argument: an internal error occurred
2-flash  / NO IMAGE (control)         "No image provided." (normal 200)
```

The image conditions are **indistinguishable from the no-image control**. The
two earlier `"Red blue"` answers were a guess (prompt: "Name the two colors").
`supportsImages:true` on `swe-1-6-slow` in `GetCliModelConfigs` is a label,
not an entitlement — the skill's "a label is not a wire identity" held again.

| Model | Verdict |
|---|---|
| `swe-1-6-slow` | `supportsImages:true` but **cannot see** — image silently ignored, 200 OK |
| `swe-2-flash-medium` | `supportsImages:false` — image **rejected** with `invalid_argument` trailer |

### Shipped change

- `devin.ts`: `image` parts dropped; no `ChatMessagePrompt.images` field 10.
- `devin-catalog.ts`: no `vision` in seed or discovery rows (server flag not trusted).
- `test/providers/devin-adapter.test.ts`: asserts captured wire has `images=[]`.
- `test/providers/devin-registry.test.ts`: asserts no `image` modality on any row.

---

## Question

Why does an image sent through the Devin adapter produce "I don't see an
image attached" / an `invalid_argument` trailer?

## Test fixture

`scripts/provider-probing/devin/devin-image-probe.mjs` generates a valid
200×200 PNG, red on the left / blue on the right (986 bytes, base64 1316
chars), saved to `D:/tmp/scratch/devin-probe/red-blue-200.png`. Verified:
PNG signature, IHDR CRC, inflated IDAT (120200 bytes), pixel (0,0)=220,30,40
and (150,0)=30,60,220.

## Evidence ledger

| # | Observation | Source | Verdict |
|---|---|---|---|
| 1 | Adapter's captured request had `images=0` even though the canonical request carried an `image` part | live capture via wrapper fetch | **Bug**: `chatMessagePrompts()` only called `joinTextParts()` (text) |
| 2 | `ImageData` = `base64_data`=1, `mime_type`=2, `caption`=3 | `vendor/proto/devin/exa/codeium_common_pb/codeium_common.proto:3783-3787` + webapp `codeium_common_pb-B0U9ydbp.js` | wire shape confirmed |
| 3 | `ChatMessagePrompt.images` = field 10 | `vendor/proto/devin/exa/chat_pb/chat.proto:350` | confirmed |
| 4 | Three independent donors build `images[]` with raw base64 (no `data:` prefix) | oh-my-pi `providers/devin.ts:715-731`, opencode `cascade.ts:186-203`, devin-proxy `proto.py:57` | encoding confirmed; webapp ACP `type:"image"` blocks are a *different* (devin-cloud) transport |
| 5 | Webapp stores `{base64Data, mimeType, caption, name}`, resizes to ≤1 MB, mime list `[image/png,image/jpeg,image/gif,image/svg+xml]` | `D:/tmp/unpacked/devin/.../assets/app-initial-CIM4TX_k.js` @3899, @5508, @15523 | confirmed |
| 6 | After adding `images[]`, `swe-2-flash-medium` returns `invalid_argument: an internal error occurred` | live probe | **Capability gate**: live `GetCliModelConfigs` reports `supportsImages:false` for this uid |
| 7 | `swe-1-6-slow` reports `supportsImages:true`, `supportsParallelToolCalls:true` | live `GetCliModelConfigs` | vision-capable model identified |
| 8 | `swe-1-6-slow` + `caption:""` → "No image was provided", `in=15` tokens | live focused variant | **Root cause**: caption is a server-side gate |
| 9 | `swe-1-6-slow` + `caption:"red-blue-200.png"` → `"Red blue"`, `in=26`, `out=98` | live focused variant (A), 2× repeat | **FIXED** |
| 9b | Control re-run: `caption:""` ×2 → "No image." / "Cannot see" (`in=15`); caption filled ×2 → "Red blue" ×2 (`in=26`) | live paired control | caption gate confirmed, reproducible |
| 10 | ACP-JSON-in-prompt variant → `in=1015`, max_tokens exhausted on thinking | live variant (C) | wrong transport for Cascade; do not use |

Focused variant results (one call each, not a guess grid):

```
A: images[]+caption                 HTTP=200 in=58  out=135  text="Red blue"      trailer={}
B: images[]+prompt-as-dataurl       HTTP=200 in=77  out=2141 text="Cannot see"     trailer={}
C: ACP JSON in prompt              HTTP=200 in=1015 out=4096 text=""              trailer={}
D: images[] caption="" (control)   HTTP=200 in=15  out=1889 text="Cannot see"     trailer={}
```

`in=` token count is the tell in the paired control: with a dropped image the
prompt costs ~15 tokens; with the image actually consumed ~26. (Treat `in` as
a hint, not proof — the model's answer is non-deterministic, and an early
single run with `caption:"image-1.png"` also produced "Cannot see". Only the
2×2 paired control above is treated as evidence.)

## Root causes (both fixed)

1. **Adapter dropped the image part.** `chatMessagePrompts()` flattened only
   text. Fixed by converting canonical `image` parts via the canonical owners
   (`resolveImageSource` + `splitDataUrl` in `src/protocol/codecs.ts`) into
   `ChatMessagePrompt.images` field 10, on the last user turn only (devin2api's
   wire observation).
2. **`ImageData.caption` must be non-empty.** Proto marks it a plain string,
   but the upstream silently discards an image whose caption is `""` — 200 OK,
   no error, model answers "Cannot see". Fixed: caption is generated as
   `image-N.<ext>` from the mime type. The `invalid_argument` trailer on a
   non-vision model now carries a hint pointing at both gates.

## Not a bug / remaining limits

- `swe-2-flash-medium` (account default) has `supportsImages:false` on this
  Free account → inline images are refused upstream. Seed declares it
  vision-capable per operator spec, but live dispatch must use a vision model.
- Of 1010 live configs, 7 are non-disabled; **only `swe-1-6-slow` is
  vision-capable**. The other 983 vision-capable rows are tier-gated
  (`disabled:true`).
- `swe-1-6-slow` did see the image but one run answered "Blue, Orange" —
  model quality on the Free tier, not a wire failure. The focused variant with
  the exact prompt answered "Red blue".
- Remote URLs / file-id image parts are not supported by this wire (only
  inline base64); `devinImageData` returns `undefined` and the image is
  dropped rather than forwarded as an unresolvable URL.

## Reproduction

```bash
# image part dropped (before fix) → "I don't see an image attached."
bun scripts/provider-probing/devin/devin-image-probe.mjs

# vision-capable model → image consumed
DEVIN_MODEL=swe-1-6-slow \
DEVIN_PROMPT='What two colors are in this image? Answer with ONLY the two color names, nothing else.' \
  bun scripts/provider-probing/devin/devin-image-probe.mjs

# non-vision model → invalid_argument (expected)
bun scripts/provider-probing/devin/devin-image-probe.mjs
```

Unit coverage: `test/providers/devin-adapter.test.ts` →
"image part is encoded as ImageData with a non-empty caption".

## Related

- `2026-11-07-devin-live-upstream-verification.md` — RPC/catalog/chat live proof
- `2026-11-07-devin-adapter-proposal-final.md` — implementation plan
- `scripts/provider-probing/devin/README.md` — probe reference
