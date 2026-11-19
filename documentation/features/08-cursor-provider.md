# Cursor Provider

The Cursor provider speaks Cursor's own Agent wire: a Connect-RPC bidirectional
stream (`agent.v1.AgentService/Run`) over HTTP/2, with a `RunSSE` +
`BidiAppend` HTTP/1 fallback. The codec is generated from
`vendor/proto/cursor/agent.proto` (`integrations/cursor/cursor-protocol/` —
generated output, never edited by hand) and framed with the shared Connect
helpers.

## Relay-only tool policy

The gateway never executes a Cursor native tool. The Run announces itself as an
external executor (`x-cursor-agent-allowed-tools:
mcp_tool_call,get_mcp_tools_tool_call`), which turns Cursor's built-ins off
server-side, and the caller's tools are advertised through the
`requestContext` handshake (`providerIdentifier: "pi-agent"`, the reference
client's live-verified literal) verbatim — a caller tool named like a native
(`read`, `todo`) still routes through `mcp_tool_call` and must not be dropped
from the catalog. `mcp_tools` on the run request stays empty. Every tool call
Cursor's model makes reaches the caller:

- Held `mcp_args` calls surface to the caller as they arrive; the dispatch ends
  with a tool-use terminal that carries `usage_deferred` (the upstream turn is
  still open, so the interim response is not estimated and billed as a finished
  turn — the real usage arrives with the resumed turn's `turn_ended`) while the
  Run stays parked (heartbeats keep its counted tool batch open).
- Smart-mode approval-only frames are gate probes, answered immediately:
  approved for a tool the caller declared, rejected for one it did not. The
  real call, when it follows, is held like any other.
- The next request resumes the parked run in-band only when the resume
  conditions hold — same model and wire id, same conversation key, exactly one
  result per held call (`canResumeParkedRun`) — and the request ends on pure
  tool results. A Messages-origin turn that carries `tool_result` blocks
  together with follow-up text cannot resume (the held run would never see the
  text); it supersedes the park and rebuilds, which carries both. The
  conversation key comes from the wire conversation ids when the caller sends
  them, else the gateway's cross-surface session resolver (inbound session
  headers such as `x-opencode-session`/`x-claude-code-session-id`, the
  Responses `conversation.conversation_id`, or a hash of the opening turn) — a
  stateless caller never mints a fresh identity per request. Anything else
  releases the run and the turn rebuilds from history. A parked run idles out
  after 30 minutes (`CURSOR_PARKED_IDLE_MS`), swept on every park, not only on
  a same-key peek.
- The declared-batch counters reset when a server-declared step's results are
  collected, so the next step's listing is judged on its own — a stale total
  would satisfy it immediately and split the next batch across responses.
- Pairing is mandatory: every exec-dispatched call leaves exactly one
  `toolResult` in the transcript, including interrupted ones
  (`flushOpenToolCalls`, wired into teardown). An unpaired call is stripped
  from every rebuilt transcript upstream, which silently corrupts the next
  turn.
- `interaction_query` frames (hosted web search, Exa, plan gates) are answered
  with an explicit rejection — the gateway serves none of the hosted
  capabilities, and a dropped frame strands the stream on non-semantic
  heartbeats until the idle watchdog kills it.

## Model identity: the pair rule

A Run request carries two identities, and they must differ:

- `model_details.model_id` — the account-usable legacy slug;
- `requested_model.model_id` — the rich base id, plus the variant's parameter
  tuple and max-mode flag (`resolveCursorModelPair` is the only sanctioned
  builder).

Reusing one string for both trips `BAD_MODEL_NAME`; sending an effort id in
both trips the resource-exhaustion error (errorId 528384). The roster comes
from three parallel RPCs (`GetUsableModels`, `AvailableModels`,
`GetDefaultModelForCli`), cached per credential with stale-serve and failure
backoff. **Re-validate the roster before trusting it**: rows are account- and
plan-scoped, and discovery is verified in code against the reference
implementation, not yet against a live account.

## History and checkpoints

History becomes one content-addressed blob per record (`root_prompt_messages_json`
holds SHA-256 ids the server pulls over the KV channel; `get` for an unknown
blob answers empty, which the server treats as "rebuild that record"). System
prompt and instructions ride as system records; the trailing user turn rides
the action — a request that instead ends in tool results resumes the run. A
`tool_result` riding that final user turn (the Messages shape: results and
follow-up text in one turn) still reaches the transcript as its own tool
record, keeping the assistant's call paired; only the text rides the action.
The final checkpoint of a clean turn is remembered byte-for-byte under the wire
route plus the digest of the history that produced it; a later request with the
same digest replays the server's own records, anything else rebuilds from
content.

## Quota

Two surfaces, ranked:

1. `cursor.com/api/usage-summary` — cookie auth
   (`WorkosCursorSessionToken=<userId>::<accessToken>`), USD cents, plan and
   on-demand buckets. Answered 401 to any `Authorization` header.
2. `{api}/auth/usage` — legacy request-count buckets, bearer auth; the only
   surface a raw `crsr_` key reaches.

The summary outranks the legacy surface entirely when it answers (different
currencies — a mixed list would cross-gate); the legacy list is the fallback.
Classic plans carry percent-only rails ("Cursor Models" / "Other Models") —
percents are never multiplied into a dollar figure. X Subscription
(`unified_*`) accounts hold one weekly pool for Cursor-owned models
(reset read from `GetPlanInfo`) plus prepaid credit for third-party models.
`cursor:usd:individual-auto` gates only the Cursor-owned families
(Grok, Composer, Auto); `cursor:usd:individual-api` gates everything else; a
window with no usable reading is an error, a quiet surface is a logged
downgrade.

## Client version

The wire identity is `cli-<date>-<sha7>` (`CURSOR_CLIENT_VERSION`, kept equal
to the monitor's fallback in `operations/client-versions.ts`). The monitor
reads the official download API (`/api/download?platform=win32-x64-user&releaseTrack=stable`)
and joins `version` + `commitSha` — a semver alone is a different identity
than the one the CLI sends. An operator can pin it with
`CARTETHYIA_CURSOR_CLIENT_VERSION`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `CARTETHYIA_CURSOR_CLIENT_VERSION` | *(unset — monitor)* | Pin the client identity. |
| `CARTETHYIA_CURSOR_HEARTBEAT_MS` | `5000` | Run heartbeat cadence; keeps a counted batch open. |
| `CARTETHYIA_CURSOR_WIRE_TRACE` | *(unset — off)* | Set to log one line per decoded Run frame (names only, never values). |

## Wire notes (live-verified 2026-11-17)

Three drifts the reference implementation answered and a naive relay gets
wrong — each one failed a live Run before it was fixed:

- `requestContextResult` is a oneof (`success` | `error` | `rejected`); the
  context rides `success.requestContext`. Setting the bare `requestContext`
  field leaves the oneof unset and the server answers "Failed to get request
  context".
- `McpToolDefinition.inputSchema` carries `google.protobuf.Value` bytes, not
  JSON text — a text-encoded schema stalls the turn before the model starts.
  The codec lives in `cursor-protocol/json-value.ts` (encode + a decode ladder
  that tolerates `Value` messages, JSON text, and bare strings).
- `McpResult.success.content` items wrap their payload in a text/image oneof
  (`McpToolResultContentItem.text = McpTextContent{ text }`). The provider
  identifier is the gateway's own literal (`pi-agent`, the reference client's
  live-verified value), echoed back on every `mcp_args` call.

## Plan entitlement is enforced at Run time

`GetUsableModels` lists the whole catalog (322 slugs on a free account) — it
is not a plan-scoped entitlement surface, so `CursorModelRoute.accountUsable`
is a weak signal. The authoritative gate is the Run itself: a plan-refused
model ends the stream with a `resource_exhausted` envelope carrying no
`ErrorDetails.code`, only a debug blob (`ERROR_RATE_LIMITED_CHANGEABLE`,
"Model unavailable on Free … with fixed settings"). Opaque envelopes are
logged at debug level with their full trailer. A plan includes model families
with **fixed settings** — on the probed free account `default` (any
reasoning), `grok-4.6-medium`, and `grok-4.7-medium` ran, and every other
variant refused regardless of its parameters being valid.

The static floor is therefore exactly that trio (`cursor-catalog.ts`):
`auto` (the account's default route alias, 200k), `cursor-grok-4.6-medium`,
and `grok-4.7-medium` (256k each). Live discovery advertises the account's
FULL roster, unfiltered — the upstream cannot separate models by plan
(`GetUsableModels` lists the whole catalog regardless of membership), so a
paid account's long tail is real entitlement and must stay visible; the Run's
own refusal is the authoritative gate for a plan-refused model.

## Verification status

Frame round-trips, the relay batch arithmetic, the resume contract, history
blobs/replay, and the quota precedence are covered by `test/providers/cursor-*.test.ts`
against the real codec. The wire has been live-probed (2026-11-17) through
`scripts/provider-probing/cursor/probe.ts`, which runs the real adapter —
`fetchCursorQuota`, `fetchCursorDiscovery`, and `cursorAdapter.dispatch`, no
hand-rolled wire code:

- `--quota` — both surfaces answered (free plan: two percent-only rails,
  weekly reset from `GetPlanInfo`), zero-bucket suppression as designed.
- `--models` — 505 routes from the three roster RPCs, the slug/rich-id pair
  and parameter tuples as designed.
- `--hit` — a Run turn end to end over HTTP/2: reasoning + text deltas, KV
  service, `turn_ended` usage, terminal.
- `--relay` — the tool round trip: turn 1 parks with a held call (tool-use
  terminal), turn 2 resumes the parked run in-band and the model answers with
  the probe's tool result.

Probe only with operator credentials (`--creds <export.json>`), and never
commit them.
