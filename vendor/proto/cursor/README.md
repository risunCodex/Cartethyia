# Cursor agent protocol definitions — vendored

## Provenance

This `.proto` file is copied verbatim from the donor repository
`Public/oh-my-pi`, path
`packages/ai/src/providers/cursor/proto/agent.proto` (4,565 lines,
120,817 bytes), at donor commit `b83f8d747c3098a4ca8bf3e22a0e10da19713911`
(`d33a0edb00 fix(ai): carry Cursor runs through auth-gateway (#17382)`).

It is the original protocol definition the Cursor agent CLI and desktop IDE
clients use; it is the source of truth for field numbers, oneof cases, and
enum values. The file is vendored for audit and regeneration, not executed at
runtime.

License: **MIT** — `oh-my-pi` is MIT (Stencil Labs, Inc.). The `.proto` file
itself is a protocol declaration published by Anysphere (Cursor); it is
vendored here under the same MIT terms.

## What runs at runtime

The runtime schema is the trimmed `protobufjs` descriptor at
`src/providers/integrations/cursor/protocol/messages.ts`. It declares only the
messages the Cartethyia adapter consumes, with wire-identical field numbers.
The full `.proto` tree is **not** loaded by the server.

Rationale: a full codegen of `agent.proto` is tens of thousands of lines of
generated code. `oh-my-pi` proved a trimmed schema is sufficient and testable.
Field numbers are pinned against this `.proto` file so upstream drift can be
detected and regenerated deliberately.

## Key messages

| Message | Declares |
|---|---|
| `AgentClientMessage` | oneof: `run_request`, `exec_client_message`, `exec_client_control_message`, `kv_client_message`, `conversation_action`, `interaction_response`, `client_heartbeat`, `prewarm_request` |
| `AgentServerMessage` | oneof: `interaction_update`, `exec_server_message`, `exec_server_control_message`, `conversation_checkpoint_update`, `kv_server_message`, `interaction_query` |
| `AgentRunRequest` | the Run request: text, model, conversation/run id, history, tool descriptors, parameters, images, MCP tools |
| `ExecServerMessage` / `ExecClientMessage` | the tool-exec channel (server→client request, client→server result) |
| `KvServerMessage` / `KvClientMessage` | the blob/KV channel (server→client request, client→server result) |
| `InteractionUpdate` | streamed deltas: text, thinking, tool-call envelopes, todo snapshots |
| `InteractionQuery` / `InteractionResponse` | permission-query channel (web search, Exa fetch, etc.) |

## Regeneration

When upstream adds a field the adapter needs:

1. Re-copy `agent.proto` from `Public/oh-my-pi` (or a newer donor).
2. Update the trimmed schema in `src/providers/integrations/cursor/protocol/messages.ts`
   with the new field numbers — they must match this file exactly.
3. Update this README's provenance line (donor commit + subject).
