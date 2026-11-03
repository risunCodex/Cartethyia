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
| `qoder/qwen3.8-flash` → `qfmodel` | ❌ always `""` | upstream empty |
| `qoder/qwen3.7-max` → `qmodel_latest` | ❌ always `""` | upstream empty |

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
