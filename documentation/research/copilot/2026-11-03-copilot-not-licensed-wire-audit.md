# Copilot Wire Audit — reference VS Code 1.144 vs Cartethyia github adapter

Date: 2026-11-03
Reference: VSCodeUserSetup-x64-1.144.0-unpacked (extension copilot-chat 0.72.0)
Trigger: account `gpt-6-luna` entered COOLDOWN auth_invalidated with
repeated `unauthorized: not licensed to use Copilot` / `forbidden`.

---

## 1. Summary

Preliminary conclusion: the adapter already sends almost all the headers the
reference sends, but **two device identity headers are missing**
(`VScode-SessionId`, `VScode-MachineId`) and **one organization header**
(`Openai-Organization`) that the reference sends on chat requests — plus an
`X-Interaction-Id` whose value differs. It is not yet proven which one triggers
"not licensed" until there is a live credential to test with.

## 2. Chat request headers — reference vs adapter

Reference source: `extensions/copilot/dist/extension.js` (minified).

| Header | Reference (VS Code 1.144) | Adapter (github.ts prepareHeaders + GITHUB_REQUEST_HEADERS) | Difference |
| --- | --- | --- | --- |
| `User-Agent` | `GitHubCopilotChat/0.72.0` (fetch wrapper) | `user-agent: GitHubCopilotChat/0.72.0` | ✅ same |
| `X-VSCode-User-Agent-Library-Version` | `node-http`/`node-fetch`/`electron-fetch` (`sH` = library ID) | `x-vscode-user-agent-library-version: vscode-chat/0.72.0` | ⚠️ **different value** (library vs extension version) |
| `Editor-Version` | `vscode/1.144.0` | `editor-version: vscode/1.144.0` | ✅ same |
| `Editor-Plugin-Version` | `copilot-chat/0.72.0` | `editor-plugin-version: copilot-chat/0.72.0` | ✅ same |
| `Editor-Device-Id` | `this._extensionInfo.deviceId` (persistent UUID) | `editor-device-id: <github install-id>` | ✅ same value |
| `Copilot-Integration-Id` | `vscode-chat` (set in `_mixinHeaders`, only if `BFi(type)` is true) | `copilot-integration-id: vscode-chat` | ✅ same (case-insensitive) |
| `X-GitHub-Api-Version` | `2026-08-01` | `x-github-api-version: 2026-08-01` | ✅ same |
| `VScode-SessionId` | `this._extensionInfo.sessionId` | **absent** | ❌ **missing** |
| `VScode-MachineId` | `this._extensionInfo.machineId` | **absent** | ❌ **missing** |
| `OpenAI-Intent` | `conversation-agent` / `conversation` (from the request) | `openai-intent: conversation-agent` | ✅ same (for regular chat) |
| `X-Request-Id` | UUID (per request) | `x-request-id: requestId` | ✅ same |
| `X-Interaction-Id` | `interactionService.interactionId` (differs from the request id) | `x-interaction-id: requestId` | ⚠️ **different value** |
| `X-Agent-Task-Id` | UUID = request id | `x-agent-task-id: requestId` | ✅ same |
| `X-Initiator` | `user` / `agent` | `x-initiator: user/agent` | ✅ same |
| `X-Interaction-Type` | `conversation-agent` (from the interaction type) | `x-interaction-type: conversation-agent` | ✅ same |
| `Openai-Organization` | `github-copilot` (on the chat stream request) | **absent** | ❌ **missing** |
| `x-policy-id` | `nil` (on certain endpoints) | **absent** | ⚠️ only on certain endpoints |

## 3. Token minting (`/copilot_internal/v2/token`)

Reference (`makeRequest` type `CopilotToken`): only `fetch(tokenURL, r)` —
**WITHOUT `_mixinHeaders`** because `BFi("CopilotToken")` = false. So token
minting in the reference only carries `User-Agent` + `X-VSCode-User-Agent-Library-Version`
from the fetch wrapper, plus `Authorization`.

Adapter (`mintGithubToken`): sends the full `GITHUB_REQUEST_HEADERS`
(including `copilot-integration-id`, `editor-version`, etc.). This is **more**
than the reference but is not the cause of "not licensed" — token minting
accepts extra headers just fine (previously verified live with 200).

## 4. Discovery (`/models`)

Reference (`Models` is in the `BFi` set): gets `_mixinHeaders` →
`Copilot-Integration-Id` + `VScode-SessionId/MachineId` + `Editor-*`.

Adapter (`discoverGithubModels`): sends `accept` + `authorization` +
`GITHUB_REQUEST_HEADERS`. **Missing `VScode-SessionId`/`VScode-MachineId`**
(same as chat). `/models` is the endpoint most likely to enforce
policy/license (where "not licensed" can appear), so this is a strong
candidate.

## 5. Auto model (gpt-6-luna)

`gpt-6-luna` is an **Auto model**: dispatch calls `POST /auto`
(`#selectAutoModel`) with `{ prompt, tier, has_image? }`.

Reference (`Auto` is in the `BFi` set): gets full `_mixinHeaders`.

Adapter (`#selectAutoModel`): uses `prepareHeaders` → already gets
`GITHUB_REQUEST_HEADERS` + `x-*` + `x-vscode-user-agent-library-version`,
but **still lacks `VScode-SessionId`/`VScode-MachineId`** and
`Openai-Organization`.

Because the "not licensed" error appears on model `gpt-6-luna`, and that model
therefore goes through `POST /auto` first, the auto-request headers are the
most likely place the license evaluation happens.

## 6. Candidates for the cause of "not licensed"

1. **`VScode-SessionId` + `VScode-MachineId` missing** — the server may
   consider the request not to come from a legitimate client (device identity
   needed for the license check).
2. **`X-VSCode-User-Agent-Library-Version` different value** — the reference sends
   a library ID (`node-http` etc.), the adapter sends `vscode-chat/0.72.0`.
   This value may be checked by the server (indicating an "authentic" client).
3. **`Openai-Organization: github-copilot` missing** — only on the chat stream
   request; possibly not required.
4. **`X-Interaction-Id` differs** — the value must come from the interaction
   service, not the request id; unlikely to trigger the license check.

## 7. What is NOT yet proven

- Which header the server actually checks for "not licensed". Needs probing:
  1. Request with the reference headers **exactly** (including `VScode-SessionId`/
     `VScode-MachineId` + `X-VSCode-User-Agent-Library-Version: node-http`)
     → does it stay 403?
  2. Request without those headers → does it change?
  3. Also compare `/auto` vs `/chat/completions` vs `/models`.
- New live credentials are required (the account is now cooldown/auth_invalidated).

## 8. Recommended changes (awaiting live verification)

A. Add `VScode-SessionId` and `VScode-MachineId` to the chat + auto +
   discovery headers. Where do the values come from?
   - `VScode-MachineId`: could be `getOrCreateInstallId("github")` (already
     exists, persistent). Try this first.
   - `VScode-SessionId`: no equivalent yet. Options: derive from the install id +
     a per-account credential hash, or `randomUUID()` per process. The reference
     uses a per-VS-Code-window session, so a persistent-per-account value is
     closer.
B. Change `x-vscode-user-agent-library-version` from `vscode-chat/0.72.0`
   to `node-http` (or `node-fetch`), matching the reference. **Note:** the
   current `github-request-context.test.ts` test expects
   `vscode-chat/0.72.0`, so this change must be accompanied by a test update.
C. Add `Openai-Organization: github-copilot` on chat requests (optional,
   only if A/B is not enough).
D. Consider separating `X-Interaction-Id` from `X-Request-Id`.

## 9. Related files

- Adapter: `src/providers/integrations/github/github.ts` (`prepareHeaders`,
  `#selectAutoModel`)
- OAuth: `src/providers/integrations/github/github-oauth.ts`
  (`GITHUB_REQUEST_HEADERS`, `mintGithubToken`)
- Discovery: `src/providers/integrations/github/github-discovery.ts`
- Quota: `src/providers/integrations/github/github-quota.ts`
- Test: `test/providers/github-request-context.test.ts`
- Reference: `D:\tmp\unpacked\vs-code\{code_GetDestDir}\2c33b50b16\resources\app\extensions\copilot\dist\extension.js`

## 10. Live probe results (2026-11-03)

Credential: `github-accounts-2026-11-03T12-57-28-223Z.json` — account
`jinhsera-design` (`access_type_sku: free_limited_copilot`, plan `individual`,
`chat_enabled: true`).

All header variants → **200** on host `api.individual.githubcopilot.com`:


| Variant | `/auto` (gpt-6-luna) | `/models` | `/chat/completions` |
| --- | --- | --- | --- |
| 0-baseline (old adapter) | 200 | 200 | 200 |
| 1 +VScode-ids | 200 | 200 | 200 |
| 2 library-ref (node-http) | 200 | 200 | 200 |
| 3 reference-full | 200 | 200 | 200 |
| new 1:1 adapter (after update) | 200 | 200 | 200 |

**Key conclusion:** headers are **not** the cause of "not licensed". Account
`jinhsera-design` is **free limited** and can still use `gpt-6-luna`
(`restricted_to` includes `free`), and every header permutation is accepted
with 200. The real cause on the old account (`thehertaborneo@gmail.com`) is
most likely the **account entitlement/plan** — not the request wire. The 1:1
change was still made because it was requested and tightens client identity
(consistent with the reference), but it does not by itself cure "not licensed"
on an account without entitlement.

## 11. Next steps

1. Get new live credentials (healthy account).
2. Probe `POST /auto` + `/models` + `/chat/completions` with:
   - (a) current adapter headers (baseline) → expect 403 "not licensed";
   - (b) exact reference headers (add `VScode-SessionId`/`VScode-MachineId`,
         `Openai-Organization`, change library-version) → check whether it
         becomes 200;
   - (c) only add `VScode-*` (without changing library-version) → isolate the
         variable.
3. Apply the minimal change based on the probe results.
4. Update the `github-request-context` test when header values change.
