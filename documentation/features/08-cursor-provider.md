# Cursor provider

Cursor's agent protocol is Connect-RPC over protobuf on a bidirectional HTTP/2
stream (`agent.v1.AgentService/Run`), so the adapter frames its own wire instead
of going through a canonical codec. Everything in this guide is verified in code
only: no claim here is a statement that Cursor serves this traffic today.

Two structural facts drive the whole integration:

- **A tool loop spans two client HTTP requests.** The first returns a tool call;
  the second submits that tool's result, and the same upstream Run must answer
  it. The Run therefore outlives the request that opened it.
- **The Run host is discovered, not configured.** `GetServerConfig` names a
  region-specific agent origin. The API host serves auth and catalog calls but
  is not the Run origin.

## What runs, and what refuses to

Only Cursor's authoritative `exec_server_message.mcp_args` is an executable tool
call, and only when its `provider_identifier` and `tool_name` match a tool the
current request declared. Everything else is answered rather than executed:

| Server message | Answered with | Why |
|---|---|---|
| `mcp_args` for a declared tool | a client `tool_call_delta` | the only executable path |
| `mcp_args` for anything else | `mcp_result{rejected}` | an undeclared tool must not run |
| `request_context_args` | `request_context_result` with RequestContext | the Run stalls forever without it |
| `mcp_state_exec_args` | `mcp_state_exec_result` from the advertised descriptors | Cursor probes availability before it emits a call |
| KV `set_blob` / `get_blob` | the matching KV result | same stall |
| every other exec variant (shell, read, edit, glob, subagent, …) | `mcp_result{rejected}` | Cursor's host tools are never run by this gateway |

`interaction_update`'s `tool_call_started` / `tool_call_completed` are display
notifications, not calls; only `turn_ended` is authoritative for a turn's end and
its usage. That refusing path is the security boundary — it is what keeps a
model's request from turning into a filesystem or shell operation on the gateway's
host.

## Continuation across requests

A Run lives in `cursorRunSessions` (`cursor-session-manager.ts`), keyed by run id
and indexed a second time by pending call id. A later request claims a call by
presenting server-recorded affinity, not just the call id: an id is unguessable,
but it is still only a string a client could carry into another key's request, so
resolution additionally requires the same tenant, API key, provider, and account
that created the Run. A mismatch is a hard refusal, never a fallback — routing one
account's tool result onto another account's Run would corrupt both conversations.

What the continuation does and does not do:

- One request whose results resolve to two different Runs is refused whole,
  rather than partially applied.
- A call that is no longer pending fails explicitly. The client resends the
  complete conversation; the gateway does not silently start a Run the model is
  not waiting on.
- When the Run's socket is gone but its record survived, the request **rebases**
  into a fresh Run from the complete request history. A fresh Run always rebases
  history into its user text, because Cursor's own checkpoint cannot be
  reconstructed after a restart and `root_prompt_messages_json` would suppress
  the RequestContext rules.
- An orphan tool result with no history and no live Run fails rather than
  starting a new Run.

The account and network-pool slot the Run holds are transferred to the session,
so request-scoped accounting settles per request while the slot lives for the
whole turn. Ownership is handed over at most once and released exactly once, on
the Run's single terminal path, however many requests touched it. An unanswered
Run is bounded by `RUN_IDLE_TTL_MS` (`cursor-shared.ts`) and expires on its own.

## Images

Caller-supplied images are untrusted and are validated before the Run is dialed.
The MIME type is derived from the bytes rather than trusted from the declared
type, because a `content-type` or data-URL media type is only a claim: a GIF
labelled `image/png` goes upstream as `image/gif`, while unrecognized bytes are
rejected even when labelled as a supported format. PNG, JPEG, WebP, and GIF are
the allowed set. The payload ceiling is `IMAGE_CLAMP_MAX_BYTES`
(`protocol/image-clamp.ts`), applied both to inline data and to a fetched body.

For a URL image: the scheme must be `https:`, the fetch goes through the
validated egress, and redirects are not followed — a public URL that redirects to
a private address is the canonical SSRF bypass. A fetch that fails is reported as
the caller's bad request, not as an upstream fault.

## Auth and identity

`crsr_`-prefixed API keys are exchanged for a JWT before dispatch
(`isExchangeableApiKey`, `cursor-shared.ts`). The device identity stamped in
`x-cursor-checksum` is derived from Cartethyia's own persisted installation id
(`integrations/shared/install-id.ts`), not from a credential or a MAC address —
Cursor counts a new machine id as a new device, so a credential-derived id would
rotate whenever an operator re-authenticated and produce the "too many devices"
symptom the stability exists to avoid.

## Where to change it

| Concern | File |
|---|---|
| Dispatch, the tool loop, image validation | `src/providers/integrations/cursor/cursor.ts` |
| Live Run registry, scope, idle expiry | `src/providers/integrations/cursor/cursor-session-manager.ts` |
| Request building (Run, MCP results, RequestContext) | `src/providers/integrations/cursor/cursor-request.ts` |
| Stream transport, frame decode, error mapping | `src/providers/integrations/cursor/cursor-http2.ts` |
| OAuth, API-key import, session refresh | `src/providers/integrations/cursor/cursor-auth.ts` |
| Catalog mapping, Run-origin discovery | `src/providers/integrations/cursor/cursor-catalog.ts` |
| Endpoints, host allowlist, idle TTL | `src/providers/integrations/cursor/cursor-shared.ts` |
| Device identity | `src/providers/integrations/cursor/cursor-identity.ts` |
| Vendored protobuf schema and framing | `src/providers/integrations/cursor/protocol/` |

## Known gaps

- Quota collector exists (`src/providers/integrations/cursor/cursor-quota.ts`,
  registered in `default-registry.ts`): it reads `/auth/usage` and
  `/api/usage-summary`. It was absent at the time this doc was first written;
  it is present now.
- The catalog is live discovery only — the roster is per-account and per-plan,
  and Cursor declares each model's capabilities, so there is no static floor.
