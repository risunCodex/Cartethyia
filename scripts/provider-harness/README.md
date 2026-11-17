# Provider acceptance harness

The local, mandatory gate for every new provider. One linear-history loop in
the mini-swe-agent discipline: deterministic tools, outcome-based checks, and
every dispatch through the real registry adapter — a harness pass is a
dispatch pass.

## Tasks

| Task | What it proves |
| --- | --- |
| `text` | A plain turn: streamed text, usage accounting, clean `complete/stop` terminal. |
| `single-tool` | One tool call, the harness answers it, the next turn reflects the result. |
| `parallel-tools` | Two independent calls both issued and both answered (exact-args check). The `INFO parallel` line reports whether the model batched them in one step — informational because batching is the model's choice; gate it with `--strict-parallel`. |
| `arg-fidelity` | Exact argument transport (`stressed` comes back as `desserts` through the provider's wire). |
| `multi-account` | One conversation continued across rotating accounts (needs 2+ accounts in the export) — recall must survive the rotation, which exercises the rebuild-from-history path. |
| `chat-surfaces` | Protocol translation: three reused-session turns with three different triggers through every caller surface dialect (chat completions, responses, messages, completion), asserted on the NATIVE encoded output. |
| `tools-surfaces` | The tool round trip in each tool-capable dialect: the call is extracted from the native output and the result fed back in the same dialect. |

The tool set is deterministic (`harness_add`, `harness_get_weather`,
`harness_reverse`) — no environment access, no flaky assertions. Prompts are
deliberately neutral: forced phrasing and odd roleplay identities trip the
upstream's usage-guidelines classifier intermittently (live-verified — a
"Request blocked" envelope), so the harness asks plain questions instead.

Same-account dispatches are paced (`--min-gap-ms`, default 3000): the upstream
answers rapid back-to-back requests on one account with an opaque
`resource_exhausted` envelope, and the harness paces itself the way the gateway
paces same-account dispatches in production. Gemini has no caller-facing
ingress (it is an upstream wire only), so it is not in the surface matrix.

## Usage

```sh
bun run scripts/provider-harness/run.ts --provider cursor \
  --creds C:\path\accounts.json --model auto
bun run ... --provider cursor --creds <file> --model auto --task parallel-tools
bun run ... --provider cursor --token <jwt> --model auto --json     # machine output
bun run ... --provider cursor --creds <file> --model auto --strict-parallel
```

Output is live: text deltas stream as they arrive, tool calls print the moment
they surface, and each step reports its terminal and usage with timestamps.
`--json` suppresses the live view and emits one machine-readable report.

## Wiring a new provider

Nothing per-provider is needed beyond what registration already declares — the
harness resolves the adapter through `createDefaultProviderRegistry()` and the
endpoint/family from the bundled module. Requirements:

1. The provider's credential export must work with
   `scripts/provider-probing/lib/accounts.ts` (`--creds <export.json>`,
   `--label`/`--index`), or pass `--token` directly.
2. Run the four tasks against the plan's included models and record the
   verdict in the provider's feature page.

Exit code is `0` only when every task passes.
