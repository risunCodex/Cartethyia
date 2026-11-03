# Qoder tool-call matrix (verified via CarteLocal live 2026-11-03)

Live verification through the dev gateway (CarteLocal at
`127.0.0.1:12800`) — chat completions with a single `bash` function tool,
`tool_choice` variants, stream + non-stream, 4 trials per combination.

## Result

| Model (virtual → roster key) | Arguments | Verdict |
| --- | --- | --- |
| `qoder/deepseek-v4.1-flash` → `dfmodel` | ✅ populated | works |
| `qoder/lite-qwen-3.7-plus` → `lite` | ✅ populated | works |
| `qoder/qwen3.8-max` → `qmodel_38max` | ✅ populated | works |
| `qoder/qwen3.7-plus` → `qmodel` | ✅ populated | works |
| `qoder/qwen3.8-flash` → `qfmodel` | ✅ populated (after fix) | works |
| `qoder/qwen3.7-max` → `qmodel_latest` | ✅ populated (after fix) | works |

## What was tried for the empty ones

All combinations still emitted `tool_calls` with `arguments: ""`:

- `tool_choice`: `auto`, `required`, object `{type:"function",function:{name}}`,
  via `parameters.tool_choice` passthrough
- `parallel_tool_calls`: true / false
- `parameters`: `enable_thinking:false`, `reasoning_effort:"none"`
- `max_completion_tokens` vs `max_tokens`
- `tools` with/without `description`, with `strict:true`
- stream and non-stream (non-stream: no `tool_calls` at all)

The finish reason is correctly `tool_calls` and the tool name arrives — only
the arguments are empty. This is an upstream/model behavior on those roster
slots, not a request-shape or adapter bug: identical request shapes produce
populated arguments on `dfmodel`, `lite`, `qmodel`, `qmodel_38max`.

**Update (2026-11-03, later) — root cause found and fixed.** The empty-args
behavior on `qfmodel`/`qmodel_latest` was an adapter bug, not upstream: those
slots echo `id: ""` on every continuation chunk (the first chunk carries the
real `call_…` id). The translator treated the empty string as a fresh call id,
so every argument fragment was buffered under `""` and lost — the real call was
emitted with empty arguments. Fix: an empty `id` now behaves like a missing one
(continuation re-joins the pinned first-seen id per wire index). After the fix,
both slots return populated arguments (3/3 trials OK) through the gateway and
end-to-end via opencode.

**Update (2026-11-03, streaming).** The empty-stream recovery previously read
the entire upstream body before forwarding it (`drainQoderResponse`), so every
stream appeared to complete in one burst at the end. `fetchQoderIdeWithEmptyRecovery`
now sniffs only the first chunks (up to 64 KiB) to decide meaningful-ness and
forwards the rest progressively (`sniffQoderStream`); reasoning-only streams are
still replayed. After the fix, the gateway forwards upstream chunks as they
arrive (measured: `qfmodel` reasoning deltas arrive 17–76 ms apart vs all at
`t=994ms` before). DeepSeek reasoning still arrives in one late burst because
the upstream emits it that way — this is upstream behavior, not the adapter.

## Notes

- Response `model` echo is `dfmodel`-style roster keys (`qfmodel` etc.), so
  the empty-args behavior keys off the roster slot, not the virtual id.
- Buffer/stitch fix in `qoderBodyToCanonicalEvents` (see commit history) is
  orthogonal: it reconciles fragmented streaming args; it cannot invent args
  the upstream never sent.
- If a deployment needs tool calling on the empty slots, the workaround is to
  route to a slot that populates args (`dfmodel`, `lite`, `qmodel`,
  `qmodel_38max`). Do not hand `qfmodel`/`qmodel_latest` a caller that
  depends on tool execution.
