# Devin (Codeium Cascade) protocol definitions — vendored

## Provenance

These `.proto` files are copied verbatim from the donor repository
`Public/oh-my-pi`, path
`packages/ai/src/providers/devin/proto/exa/**` (33 files, ~709 KiB).
They are the original protocol definitions the Devin/Windsurf desktop and CLI
clients use; they are the source of truth for field numbers and enum values.

License: **MIT** — `oh-my-pi` is MIT (Stencil Labs, Inc.). The `.proto` files
themselves are protocol declarations published by Exafunction/Codeium; they are
vendored here for audit and regeneration, not executed at runtime.

## What runs at runtime

The runtime schema is the trimmed `protobufjs` descriptor at
`src/providers/integrations/devin/protocol/devin-proto.ts`. It declares only
the messages the Cartethyia adapter consumes, with wire-identical field
numbers. The full `.proto` tree is **not** loaded by the server.

Rationale: a full codegen of these protos is 69K–237K lines of generated code
(opencode-devin-provider / devin2api). oh-my-pi proved a ~2.7K-line trimmed
schema is sufficient and testable. Field numbers are pinned against these
`.proto` files so upstream drift can be detected and regenerated deliberately.

## Key files

| Proto | Declares |
|---|---|
| `exa/codeium_common_pb/codeium_common.proto` | `Metadata`, `ClientModelConfig`, `ModelInfo`, `ModelFeatures`, `ModelDimension`, `ChatToolCall`, `ModelUsageStats`, `StopReason`, `TeamsTier` |
| `exa/api_server_pb/api_server.proto` | `ApiServerService`: `GetChatMessage`, `AssignModel`, `GetCliModelConfigs` + request/response messages |
| `exa/chat_pb/chat.proto` | `ChatMessagePrompt`, `ChatToolDefinition`, `ChatToolChoice`, `PromptCacheOptions`, `CompletionConfiguration` |
| `exa/auth_pb/auth.proto` | `AuthService.GetUserJwt` |
| `exa/seat_management_pb/seat_management.proto` | `SeatManagementService`: `ExchangePKCEAuthorizationCode`, `GetUserStatus`, `PlanInfo`, `PlanStatus`, `UserStatus` |

## Regeneration

When upstream adds a field the adapter needs:

1. Diff the changed `.proto` against the vendored copy.
2. Add the field to the matching `addType(...)` entry in
   `src/providers/integrations/devin/protocol/devin-proto.ts` with the exact
   field number.
3. Update the decode/encode site and extend
   `test/providers/devin-wire.test.ts` with a round-trip assertion.
4. Run `bun run typecheck` and the Devin tests.

Do **not** replace the trimmed schema with a full codegen without a measured
reason — the trimmed form is what keeps audit and drift detection cheap.

## Related

- Audit + live OAuth evidence: `documentation/research/devin/`
- Implementation proposal: `documentation/research/devin/2026-11-07-devin-adapter-proposal-final.md`
