# Proposal: Qoder probe-tooling reorg (DRY / proper / consistent)

Date: 2026-11-04 · Status: **executed — see §8 for the final result**
Scope: `scripts/provider-probing/qoder/` (22 files → 13)

## 1. Why

The Qoder probe scripts grew organically from live experiments. An audit
(read-only, subagent) found that the directory is heavily duplicated and
violates several repo conventions (`any` casts, stale version constants,
conflicting URL hosts, hand-rolled parsers, a header that claims redaction but
does not redact). No `test/`, `dashboard/`, or `src/` code references these
scripts (verified), so rewriting is safe with zero test impact.

## 2. Audit findings (summary)

### 2.1 Duplication clusters

| Cluster | Files | What is duplicated |
| --- | --- | --- |
| Chat surface | `chat/probe-qoder.ts`, `chat/probe-qoder-meta.ts`, `chat/qoder-transport-probe.ts` | IDE `/model/v1` headers + body, `parseArgs` sequence, `auth` literal; **three conflicting header/body variants** for the same surface (machine-id headers vs os/hostname-only; body wrapped in `{body,rid,sid}` vs bare) |
| Quota trio | `quota/qoder-quota-probe.ts`, `quota/qoder-entitlement-probe.ts`, `quota/qoder-account-info.ts` | Same endpoints (`/userinfo`, `/quota/usage`, roster), same `show()` printer, same `auth` literal |
| gRPC pair | `grpc/qoder-grpc-meta.ts`, `grpc/qoder-grpc-modelname.ts` | Exact duplicate `materializeChatProto()` + proto-loader + request/metadata construction; meta is a strict superset |
| Legacy COSY | `chat/qoder-legacy-reply.ts`, `chat/qoder-lite-cosy-1m.ts`, `chat/qoder-response-shape.ts` (+ transport) | Identical `agent_chat_generation` body builder (4 copies, differing only in `display_name`, `is_reasoning`, payload) |
| Capacity experiments | `chat/qoder-context-probe.ts`, `chat/qoder-session-retention-probe.ts` | ~80% shared wire code (same headers/body skeleton), different questions |
| Machine identity | 5 files | Verbatim `machineOs()`/`machineHostname()` copies; hardcoded `"aarch64_macos"`/`"DESKTOP-QODER"` in 6 files |

### 2.2 Red flags ("not proper")

- **`any`/`as any` casts**: `chat/probe-qoder-meta.ts` L158 (`let json: any`), `chat/qoder-response-shape.ts` L166, `grpc/qoder-grpc-meta.ts` L74/132/148, `grpc/qoder-grpc-modelname.ts` L60/98/111.
- **Version drift**: `"1.1.81"` in most files, `"1.1.80"` (stale) in 6 files, `1.1.64` user-agents in `src/`. Nine literals instead of one constant.
- **Conflicting URL hosts**: model-list endpoint uses `api2.qoder.sh` (`probe-qoder.ts`) vs `openapi.qoder.sh` (roster/entitlement). Genuine unresolved discrepancy.
- **Hand-rolled argv parser** (`chat/qoder-context-probe.ts`) instead of `node:util parseArgs`; dual-option flags (`perTurn`/`"per-turn"`, `timeoutMs`/`"timeout-ms"`).
- **`qoder-account-info.ts` header claims "(redacts tokens)"** but the code prints raw body slices up to 6000 chars — no redaction.
- **Stale references**: `auth/qoder-device-login.ts` L137 hint points at nonexistent `auth/probe-qoder.ts`; `scripts/provider-probing/README.md` layout section still lists old root-level paths; README documents a `--ctx` flag that does not exist on `probe-qoder.ts`.
- **`probe-qoder-credits.ts`**: `CAMPAIGNS_PATH = CLAIM_PATH = REWARD_PATH` (three constants for one string), `void main()` fire-and-forget.
- **Dead code**: `probe-qoder.ts` `void machineId;`, `qoder-response-shape.ts` dead `if (inner?.object)` branch.

## 3. Target structure (13 files instead of 22)

```
provider-probing/qoder/
  main.ts                        # keep; update aliases to renamed files
  cosy-signer.ts                 # keep (already the shared signer)
  lib/
    shared.ts                    # NEW — see §4
    grpc.ts                      # NEW — gRPC client factory
  chat/
    probe-qoder.ts               # KEEP as canonical chat probe (absorbs 5 files)
    qoder-capacity-probe.ts      # MERGE: context-probe + session-retention-probe
  quota/
    probe-qoder-credits.ts       # KEEP (unique sash logic; fix constants)
    qoder-entitlement-probe.ts   # MERGE: quota-probe + roster-model + account-info
  grpc/
    qoder-grpc-meta.ts           # KEEP as gRPC probe (absorbs modelname)
  auth/
    qoder-device-login.ts        # KEEP; fix "Next:" path
    qoder-export-accounts.ts     # KEEP (or convert to parseArgs)
  inspect/
    qoder-body-inspect.ts        # KEEP as-is
```

### 3.1 Merge map (deleted files → destination)

| Deleted file | Destination | How |
| --- | --- | --- |
| `chat/qoder-transport-probe.ts` | `chat/probe-qoder.ts` | `--surface ide\|legacy\|both` (default `both`); `--surface plain-bearer` |
| `chat/qoder-response-shape.ts` | `chat/probe-qoder.ts` | `--model-echo` mode |
| `chat/qoder-cross-model.ts` | `chat/probe-qoder.ts` | `--cross` mode (loop model list) |
| `chat/qoder-business-probe.ts` | `chat/probe-qoder.ts` | `--headers minimal\|machine` mode |
| `chat/qoder-legacy-reply.ts` | `chat/probe-qoder.ts` | `--surface legacy --reply` |
| `chat/qoder-lite-cosy-1m.ts` | `chat/probe-qoder.ts` | `--lite --chars N` mode |
| `chat/qoder-context-probe.ts` | `chat/qoder-capacity-probe.ts` | `--mode context` |
| `chat/qoder-session-retention-probe.ts` | `chat/qoder-capacity-probe.ts` | `--mode retention` |
| `quota/qoder-quota-probe.ts` | `quota/qoder-entitlement-probe.ts` | `--header-mode Bearer\|Cosy\|signed` |
| `quota/qoder-roster-model.ts` | `quota/qoder-entitlement-probe.ts` | `--roster-key <key>` |
| `quota/qoder-account-info.ts` | `quota/qoder-entitlement-probe.ts` | `--full` mode (raw dump, redacted) |
| `grpc/qoder-grpc-modelname.ts` | `grpc/qoder-grpc-meta.ts` | `--echo-only` / `--quiet` mode |

## 4. New shared helper modules

### `lib/shared.ts`
- `QODER_VERSION = "1.1.81"` — single source (verify `1.1.80` cluster against `src/` before dropping).
- `machineOs()`, `machineHostname()` — canonicalized from the 5 copies.
- `ideChatHeaders({ token, version?, machineId?, hostname?, os? })` — one IDE header builder (replaces 6 inline variants).
- `QoderProbeAuth` type + `authFromAccount(account)` — moved from `cosy-signer.ts`, re-exported there for compat.
- `loadProbeAccount({ creds?, label?, index?, providerId? })` → `{ account, token, userId, machineId, auth }` — replaces the 14 repeated 6-line account-loading sequences.
- `buildLegacyChatBody({ model, userId, text?, isReasoning?, displayName?, maxInputTokens?, maxOutputTokens? })` — kills the 4 legacy-body copies.
- `buildIdeChatBody({ model, version, maxTokens?, contextTokens? })`.
- `readSse(response, { onDelta?, onReasoning?, onModel?, onError?, onDone?, maxFrames? })` — replaces the 5 hand-rolled SSE readers.
- URL constants imported from `src/providers/integrations/qoder/qoder-realm.ts` where available; **document the `api2` vs `openapi` host discrepancy once** (genuine open question — do not silently pick one).

### `lib/grpc.ts`
- `materializeChatProto()`, `createChatService(realm)`, `probeChatStream(request, metadata, { timeoutMs, onChunk, onMetadata, onStatus })` → `{ answer, reasoning, firstModel, usage, extras, initialMeta, trailers }` — absorbs the exact duplicated gRPC block.

## 5. Housekeeping / invariants to restore

- Ban `any` everywhere (strict TS per AGENTS.md).
- Unify CLI: `node:util parseArgs` everywhere; standardize timeout flag to `--timeout-ms`; drop dual-option flags; decide `--creds` required-vs-checked once.
- Fix `qoder-account-info.ts` redaction claim (adopt entitlement's `summarize`).
- Fix `qoder-device-login.ts` hint → `chat/probe-qoder.ts`; add `--label`/`--index` where missing.
- `probe-qoder-credits.ts`: collapse three identical path constants into one; make `main()` awaited.
- Update `scripts/provider-probing/README.md`: layout + flag table + gRPC section to match the final structure.
- Update `main.ts` alias map.

## 6. Validation plan

- `bun run typecheck` clean.
- Run every retained probe headless (no creds) to confirm import/CLI correctness.
- Spot-run `main.ts <alias>` for each alias; confirm usage output.
- `grep` the repo for stale path references (old `qoder/...` names) → zero active references.

## 7. Caveats

- gRPC probes depend on `@grpc/grpc-js` / `@grpc/proto-loader` — already imported in-tree; nothing to change.
- Deleted browser/claim300 scripts (`qoder-browser-pat-claimer.ts`, `qoder-claim300-*`) are already gone; if their behavior is ever needed again, re-add as a mode of `probe-qoder-credits.ts`, not as new scripts.
- `cosy-signer.ts` intentionally stays gateway-free (documented); the shared URL constants may import `qoder-realm.ts` (5 files already do).

## 8. Execution record (2026-11-04)

### Final structure (13 files)

```
provider-probing/qoder/
  main.ts                        # dispatcher (12 aliases)
  cosy-signer.ts                 # unchanged (shared signer)
  lib/
    shared.ts                    # NEW — machine identity, headers, body builders, SSE reader, account loader, redacting printer
    grpc.ts                      # NEW — gRPC client factory + probeChatStream
  chat/
    probe-qoder.ts               # rewrote — absorbs transport/response-shape/cross/business/legacy-reply/lite
    probe-qoder-meta.ts          # kept; fixed `any` (typed JSON), fixed hint path
    qoder-capacity-probe.ts      # NEW — absorbs context + session-retention
  quota/
    probe-qoder-credits.ts       # kept (sash logic); constants fixed
    qoder-entitlement-probe.ts   # rewrote — absorbs quota-probe/roster/account-info (--header-mode, --full redacted, --roster-key)
  grpc/
    qoder-grpc-meta.ts           # rewrote — absorbs modelname (--echo-only); imports fixed; strict TS
  auth/
    qoder-device-login.ts        # kept; hint path fixed
    qoder-export-accounts.ts     # kept
  inspect/
    qoder-body-inspect.ts        # kept
```

### Deleted (12 files)
`chat/qoder-transport-probe.ts`, `chat/qoder-response-shape.ts`, `chat/qoder-cross-model.ts`, `chat/qoder-business-probe.ts`, `chat/qoder-legacy-reply.ts`, `chat/qoder-lite-cosy-1m.ts`, `chat/qoder-context-probe.ts`, `chat/qoder-session-retention-probe.ts`, `quota/qoder-quota-probe.ts`, `quota/qoder-roster-model.ts`, `quota/qoder-account-info.ts`, `grpc/qoder-grpc-modelname.ts`.

### Fixed along the way
- No `any`/`as any` anywhere in the directory (grep-verified).
- Version literals unified to `QODER_VERSION = "1.1.81"` (was 9 literals across 2 values).
- Shared helpers: `loadProbeAccount`, `ideChatHeaders`, `buildIdeChatBody`, `buildLegacyChatBody`, `readSse`, `summarizeRedacted`, `machineOs`, `machineHostname`.
- `--full` redaction fixed (was: header claimed redaction, code printed raw).
- README (`scripts/provider-probing/`) layout + flag table + gRPC section updated; `2026-11-04-qoder-grpc-1m-context.md` probe references updated.
- URL host discrepancy (`api2` vs `openapi` model-list) documented in `lib/shared.ts`, not silently resolved.

### Validation
- `bun run typecheck` clean.
- All probe entry points run (CLI errors raised correctly without creds; `body-inspect` runs fully).
- `main.ts` lists and dispatches all 12 aliases.
- No active references to deleted files outside the proposal + intentional header notes.
