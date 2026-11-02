> # ARCHIVED — UNTRUSTED
>
> This file was archived on 2026-10-23. It is a **point-in-time record**, not a
> description of current behavior: every `file:line`, symbol, path, and
> measurement below was true when it was written and has not been kept in sync.
> Do not read it to answer a question about the current codebase, and never cite
> it as evidence. See the [project README](../../../README.md).

# Copilot Chat 0.70.0 — capability map

Source: `VSCodeUserSetup-x64-1.142.0.exe`, extracted statically to
`D:\tmp\vscode-142`. The installer was not run.

| | |
|---|---|
| VS Code | 1.142.0 stable, commit `6d62b1d5dace93a33b3a6d3eca1317bd5e15bcb1`, built 2026-10-15 |
| Extension | `GitHub.copilot-chat` 0.70.0, build 1, `completionsCoreVersion` 1.378.1799 |
| Bundle | `extensions/copilot/dist/extension.js`, 19,748,056 bytes |
| `package.json` | 201,852 bytes, 133 commands, 188 settings |

Per-model token numbers are **not in the bundle**. The catalog comes from the
server (`GET {capi}/models`) and is cached per account. What the bundle carries
is the formula and the defaults, not the model list.

## Token limits

The server catalog gives three numbers per model. When one is missing, the bundle
fills it in:

```text
contextWindow  = contextWindow ?? (maxInputTokens ?? 0) + maxOutputTokens
maxOutputTokens = min(maxOutputTokens, contextWindow)
maxInputTokens  = min(maxInputTokens ?? sisa, contextWindow - maxOutputTokens)
```

Defaults when the catalog has no entry at all: context 128,000, input
100,000, output 8,192. Defaults when an entry exists but its fields are empty:
prompt 8,192, output 4,096.

A chat request sends `max_tokens` = that model's `maxOutputTokens`, unless the
request already carries a `prediction`. The Responses API sends the same number
as `max_output_tokens`. The debug log prints `max_tokens ?? 2048`, so 2,048 is
a log fallback, not a model limit.

`luna` is not named in the bundle. `gpt-6-luna` is not present. What is present:
`gpt-5.6-luna`, used as the default execution-subagent model. The 1M context
claim for luna cannot be verified from this bundle — the number lives in the
`/models` response, not in the code.

## contextTier

Not a header, and not for normal chat. Only Copilot CLI sessions send it, as a
session option (`updateOptions({ contextTier })`), not a body field.

```text
function Fet(promptTokens, model) {
  if (!model.defaultContextMax) return undefined;
  if (promptTokens is not a number) {
    const ceiling = model.maxInputTokens ?? model.maxContextWindowTokens;
    const hasLongPrice = model.longContextInputCost !== undefined
                      || model.longContextOutputCost !== undefined;
    return model.defaultContextMax < ceiling && !hasLongPrice
      ? "long_context" : undefined;
  }
  return promptTokens > model.defaultContextMax ? "long_context" : "default";
}
```

So `long_context` is sent only when the model has a `defaultContextMax`, its
input ceiling is larger than that, and the model does **not** carry its own
long-context pricing. A model with long-context pricing is not sent a tier —
the server decides that from the prompt size.

The other `long_context` in the bundle is the name of a system-prompt section
("for input above ~10k tokens, write an outline first"), not a request field.

## Header

Two paths, and they differ in version.

Chat (`_fetchWithInstrumentation` and the CAPI request builder):

| Header | Value |
|---|---|
| `Authorization` | `Bearer <copilot token>` |
| `X-Request-Id` | request id |
| `OpenAI-Intent` | interaction kind, or override |
| `X-GitHub-Api-Version` | `2025-05-01` on one path, `2026-01-09` on the other |
| `X-Interaction-Id` | session interaction id |
| `X-Interaction-Type` | interaction kind |
| `X-Agent-Task-Id` | same as the request id |
| `X-Initiator` | `user` or `agent` |
| `Copilot-Vision-Request` | `true`, only when an image is present and the model supports vision |
| `Copilot-Integration-Id` | `vscode-chat` (prod) or `vscode-chat-dev` |
| `Request-Hmac` | dev build only |
| `Editor-Version` | `vscode/<version>` |
| `Editor-Plugin-Version` | `copilot-chat/0.70.0` |

GitHub REST (`_mixinHeaders`, only for certain request types):

| Header | Value |
|---|---|
| `X-GitHub-Api-Version` | `2026-08-01` |
| `VScode-SessionId` | session id |
| `VScode-MachineId` | machine id |
| `Editor-Device-Id` | device id |

Header allowlist that may be forwarded: `api-key`, `authorization`,
`content-type`, `openai-intent`, `x-github-api-version`, `x-initiator`,
`x-interaction-id`, `x-interaction-type`, `x-onbehalf-extension-id`,
`x-request-id`, `x-vscode-user-agent-library-version`.

## Reasoning

Effort is not sent when the model declares no level. The
`github.copilot.chat.reasoningEffortOverride` override wins over the requested
effort, and an effort absent from the server list is dropped with a warning
rather than sent.

Per wire:

| Wire | Field |
|---|---|
| chat completions | `reasoning_effort` |
| responses | `reasoning.effort` |
| anthropic messages | `output_config.effort` |

Anthropic thinking: `adaptive` when the model supports it, otherwise `enabled`
with `budget_tokens` = min(max budget, max_tokens − 1, max(min budget,
16,000)). Default effort when none is requested: `medium` when present,
otherwise the middle level.

`github.copilot.chat.claudeDefaultReasoningEffort`: `""`, `low`, `medium`,
`high`, `max`. There is no `xhigh` in this setting.

## Endpoint

Base: `https://api.githubcopilot.com` (CAPI), `https://copilot-proxy.githubusercontent.com`
(proxy), `https://api.github.com` (dotcom), `https://uploads.github.com`.

| Getter | Path |
|---|---|
| `capiChatURL` | `{capi}/chat/completions` |
| `capiResponsesURL` | `{capi}/responses` |
| `capiMessagesURL` | `{capi}/v1/messages` |
| `capiModelsURL` | `{capi}/models` |
| `capiAutoModelURL` | `{capi}/models/session` |
| `capiModelRouterURL` | `{capi}/models/session/intent` |
| `capiAutoURL` | `{capi}/auto` |
| `capiEmbeddingsURL` | `{capi}/embeddings` |
| `remoteAgentsURL` | `{capi}/agents` |
| `listSkillsURL` | `{capi}/skills` |
| `searchSkillURL` | `{capi}/search` |
| `copilotAgentSessionsURL` | `{capi}/agents/sessions` |
| `copilotAgentJobsURL` | `{capi}/agents/swe` |
| `tokenURL` | `{dotcom}/copilot_internal/v2/token` |
| `contentExclusionURL` | `{dotcom}/copilot_internal/content_exclusion` |
| `embeddingsURL` | `{dotcom}/embeddings` |
| `embeddingsCodeSearchURL` | `{dotcom}/embeddings/code/search` |
| `chatAttachmentUploadURL` | `https://uploads.github.com/copilot/chat/attachments` |
| proxy completions | `{proxy}/v1/engines/gpt-4o-copilot/completions` |
| proxy chat | `{proxy}/chat/completions` |
| MCP | `https://api.githubcopilot.com/mcp/` |

Model lab: `https://api-model-lab.githubcopilot.com`. Telemetry:
`https://copilot-telemetry.githubusercontent.com`.

## Tools — 38

Built-in toolset: `edit` (6), `execute` (2), `read` (6), `search` (7),
`vscode` (8), `web` (3).

### Read

| Tool | Ref | Required parameters | Condition |
|---|---|---|---|
| `copilot_readFile` | `readFile` | `filePath`, `startLine`, `endLine` | — |
| `copilot_viewImage` | `viewImage` | `filePath` | `tools.viewImage.enabled` (default on) |
| `copilot_listDirectory` | `listDirectory` | `path` | — |
| `copilot_readProjectStructure` | — | — | — |
| `copilot_getErrors` | `problems` | — (`filePaths` optional) | — |
| `copilot_getNotebookSummary` | `getNotebookSummary` | `filePath` | — |
| `copilot_readNotebookCellOutput` | `readNotebookCellOutput` | `filePath`, `cellId` | — |

### Search

| Tool | Ref | Required parameters | Condition |
|---|---|---|---|
| `copilot_searchCodebase` | `codebase` | `query` | — |
| `copilot_findFiles` | `fileSearch` | `query` | — |
| `copilot_findTextInFiles` | `textSearch` | `query`, `isRegexp` | — |
| `copilot_searchWorkspaceSymbols` | `symbols` | `symbolName` | — |
| `copilot_findTestFiles` | `findTestFiles` | `filePaths` | — |
| `copilot_getChangedFiles` | `changes` | — | `getChangedFilesTool.enabled` (default off) |
| `search_subagent` | `searchSubagent` | `query`, `description`, `details` | search + explore agent on |
| `explore_subagent` | `exploreSubagent` | same | search on, explore off |

`search_subagent` and `explore_subagent` cancel each other out. Both default to
off (`searchSubagent.enabled` = false).

### Edit

| Tool | Ref | Required parameters | Condition |
|---|---|---|---|
| `copilot_applyPatch` | `applyPatch` | `input`, `explanation` | — |
| `copilot_replaceString` | `replaceString` | `filePath`, `oldString`, `newString` | `disableReplaceTool` not set |
| `copilot_multiReplaceString` | `multiReplaceString` | `explanation`, `replacements` | same |
| `copilot_insertEdit` | `insertEdit` | `explanation`, `filePath`, `code` | — |
| `copilot_createFile` | `createFile` | `filePath`, `content` | — |
| `copilot_createDirectory` | `createDirectory` | `dirPath` | — |
| `copilot_editNotebook` | `editNotebook` | `filePath`, `editType`, `cellId` | — |
| `copilot_editFiles` | `editFiles` | — | placeholder, description is "do not use" |

### Execute

| Tool | Ref | Required parameters | Condition |
|---|---|---|---|
| `execution_subagent` | `executionSubagent` | `query`, `description` | default on, model `gpt-5.6-luna`, limit 10 tool calls |
| `copilot_runNotebookCell` | `runNotebookCell` | `filePath`, `cellId` | — |
| `copilot_runVscodeCommand` | `runCommand` | `commandId`, `name` | — |

### Web and GitHub

| Tool | Ref | Required parameters | Condition |
|---|---|---|---|
| `copilot_fetchWebPage` | `fetch` | `urls`, `query` | not web |
| `copilot_githubRepo` | `githubRepo` | `repo`, `query` | GitHub MCP off (default) |
| `copilot_githubTextSearch` | `githubTextSearch` | `scope`, `query` | — |

### VS Code, memory, session

| Tool | Ref | Required parameters | Condition |
|---|---|---|---|
| `copilot_getVSCodeAPI` | `vscodeAPI` | `query` | — |
| `copilot_createNewWorkspace` | `newWorkspace` | `query` | default on |
| `copilot_createNewJupyterNotebook` | `createJupyterNotebook` | `query` | — |
| `copilot_installExtension` | `installExtension` | `id`, `name` | skill install off (default) |
| `copilot_switchAgent` | `switchAgent` | `agentName` | default off, Plan only |
| `skill` | `skill` | `skill` | default off |
| `copilot_memory` | `memory` | `command` | — |
| `copilot_resolveMemoryFileUri` | `resolveMemoryFileUri` | `path` | — |
| `copilot_sessionStoreSql` | `sessionStoreSql` | `description` | `sessionSearch.enabled` |

Memory has three tiers under `/memories/`: user (across workspaces), repo, and
session. Session SQL is read-only: only `SELECT` and `WITH`.

## Built-in skills — 15

| Skill | Session | Condition |
|---|---|---|
| `project-setup-info-local` | local | Context7 off |
| `project-setup-info-context7` | local | Context7 on |
| `install-vscode-extension` | local | skill install + new workspace on |
| `get-search-view-results` | local | — |
| `troubleshoot` | local, cli | — |
| `agent-customization` | local, cli | — |
| `migrate-customizations` | cli, claude, codex | — |
| `init` | local | — |
| `create-prompt` | local | — |
| `create-instructions` | local | — |
| `create-skill` | local | — |
| `create-agent` | local | — |
| `create-hook` | local | — |
| `create-canvas` | cli | `chat.canvases.enabled` |
| `chronicle` | local | session search on |

Prompt file: `plan.prompt.md`, plus six chronicle prompts (standup, tips,
cost, improve, reindex, search) that all wait for session search.

## Chat participants — 9

| Id | Location | Commands |
|---|---|---|
| `github.copilot.default` | panel | explain, review, tests, fix, new, newNotebook, semanticSearch, setupTests |
| `github.copilot.editingSession` | panel | — |
| `github.copilot.editingSessionEditor` | editor | — |
| `github.copilot.editsAgent` | panel | error, compact, explain, review, tests, fix, new, newNotebook, semanticSearch, setupTests |
| `github.copilot.notebook` | notebook | fix, explain |
| `github.copilot.notebookEditorAgent` | notebook | fix, explain |
| `github.copilot.vscode` | panel | search |
| `github.copilot.terminal` | terminal | explain |
| `github.copilot.terminalPanel` | panel | explain |

## Model providers — 11

`copilot`, `copilotcli` (when: false), `anthropic`, `xai`, `gemini`,
`openrouter`, `openai`, `ollama` (deprecated), `customoai` (deprecated, not
stable), `customendpoint`, `azure`.

## Settings that change the request contract

| Setting | Default | Effect |
|---|---|---|
| `chatCompletionsTokenParameter` | `max_tokens` | `max_tokens` or `max_completion_tokens` |
| `reasoningEffortOverride` | null | wins over requested effort, dropped when the model does not support it |
| `claudeDefaultReasoningEffort` | `""` | `low`/`medium`/`high`/`max` |
| `anthropic.useMessagesApi` | true | Claude goes through `/v1/messages` |
| `anthropic.contextEditing.mode` | `off` | `clear-thinking`, `clear-tooluse`, `clear-both` |
| `responsesApiContextManagement.enabled` | false | responses compaction |
| `responsesApi.promptCacheKey.enabled` | false | — |
| `responsesApi.promptCacheBreakpoint.enabled` | false | — |
| `useResponsesApiTruncation` | false | — |
| `gpt56Verbosity.enabled` | true | `text.verbosity` on responses |
| `virtualTools.threshold` | 128 | tools above this become virtual |
| `agent.temperature` | null | — |
| `agent.largeToolResultsToDisk.thresholdBytes` | 8192 | — |
| `executionSubagent.model` | `gpt-5.6-luna` | — |
| `executionSubagent.toolCallLimit` | 10 | — |
| `searchSubagent.toolCallLimit` | 4 | — |
| `instantApply.shortContextLimit` | 8000 | — |
| `modelCapabilityOverrides` | `{}` | overrides model capabilities from the catalog |

## What is not in the bundle

- The model list and per-model token numbers. That is the `GET /models` response.
- `gpt-6-luna` and its 1M context claim.
- `xhigh` as an effort. The Claude setting stops at `max`.
- A dedicated header to raise the context window on the chat path. `contextTier`
  exists only in CLI sessions, and only for models without long-context pricing.
