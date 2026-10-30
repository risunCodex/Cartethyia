# Copilot Auto routing â€” VS Code 1.144.0

Static trace of the supplied `VSCodeUserSetup-x64-1.144.0.exe`. The installer
was unpacked, never executed. This is a new current-build note; the
[0.70.0 capability map](2026-10-15-copilot-chat-capability-map.md) is
an archived historical comparison, not current evidence.

## Pinned source

| Component | Evidence |
|---|---|
| VS Code | 1.144.0, commit `2c33b50b16c472efe58357d1d2a8a5414bc23fbf`, built 2026-10-27 |
| GitHub Copilot Chat | 0.72.0, build 1 |
| Completions core | 1.378.1799 |
| Extension bundle | `extensions/copilot/dist/extension.js` |
| Local extracted bundle | `D:\tmp\VSCodeUserSetup-x64-1.144.0-unpacked\{code_GetDestDir}\2c33b50b16\resources\app\extensions\copilot\dist\extension.js` |

## Auto endpoint and active flow

The configured CAPI base defaults to `https://api.githubcopilot.com` and can be
overridden by the authenticated endpoint configuration. In the extension
bundle, the Auto v2 fetcher makes this request:

```http
POST {capi}/auto
Authorization: token <Copilot token>
Content-Type: application/json
```

It uses a five-second abort timeout. The JSON body contains `prompt` and may
also contain `has_image: true`, `multi_turn`, and `tier`. The `tier` property is
omitted when the caller provides no tier. The response must contain
`selected_model.id`; the client also reads `session_token`, `expires_at`,
`discounted_costs`, `autoDiscount`, optional selected-model capability
metadata, and optional `hydra_scores`.

The caller is `AutoModeService._route`. It resolves the tier, calls the Auto v2
fetcher, maps `selected_model.id` to a known endpoint or constructs an endpoint
from usable response metadata, rejects a model without vision for image
requests, and caches the result per conversation. An omitted tier is logged as
`server default`; this is not evidence that the server names that mode
`standard`.

The bundle also retains URL getters and generic dispatch cases for
`{capi}/models/session` and `{capi}/models/session/intent`. They form the older
Auto-model/model-router path. The current Auto v2 call path above goes to
`POST /auto`; no direct call site for the `ModelRouter` request type appeared
in the pinned bundle. Do not treat the retained getters as proof that the old
router is the active Auto path.

## Tier names: bundle evidence vs. observed UI

The extracted 1.144.0 / Copilot Chat 0.72.0 bundle contains these accepted
values and aliases:

| Wire value | UI label | Notes |
|---|---|---|
| `efficiency` | Efficiency | Accepted tier |
| `balance` | Balance | Accepted tier; general fallback |
| `intelligence` | Intelligence | Accepted tier |
| `fast` | Fast | Accepted for managed/session routing and tier override; not in the explicit user-selectable tier set |
| `eco` | â€” | Normalized to `efficiency` |
| `balanced` | â€” | Normalized to `balance` |
| `max` | â€” | Normalized to `intelligence` |

In that bundle, **Optimize for** exposes the first three values; `fast` is an
additional routing value. For unconfigured requests, the resolver selects
`fast` in editor, terminal, and notebook locations, and `balance` elsewhere.
A configured override is checked against all four accepted values.

The user-provided UI screenshot shows **Standard / High / Max** under the same
**Optimize for** heading. A live probe on 2026-10-30 tested the proposed
legacy-wire mapping against `POST /auto` using a freshly minted Copilot token:

| Proposed UI label mapping | `tier` tested | HTTP | `selected_model.id` |
|---|---|---:|---|
| Standard | `efficiency` | 200 | `gpt-6-luna` |
| High | `balance` | 200 | `mai-code-1.1-flash` |
| Max | `intelligence` | 200 | `mai-code-1.1-flash` |

This confirms that the three legacy tier values are still accepted by the live
Auto endpoint and produce the observed selections for the probe prompt. The
model choice is server-side and can vary by account, prompt, and system state;
these three responses are evidence of acceptance, not a guarantee of fixed
model assignment.

The mapping from screenshot labels to wire values is consistent with the live
results and prior tier names, but the screenshot itself does not expose a
network trace. Thus the client UI-to-wire mapping is strongly supported, not
directly captured. Do not send `standard`, `high`, or `max` merely because
those are the visible labels: this probe tested and accepted `efficiency`,
`balance`, and `intelligence`. The inspected bundle normalizes legacy `max` to
`intelligence`, and it does not mark the three legacy values as deprecated.

The direct probe used a short neutral prompt, current API version
`2026-08-01`, VS Code 1.144.0 / Copilot Chat 0.72.0 headers, and no inference
request. An earlier attempt with the exported Copilot access token returned
`400` (`IDE token ... invalid token format`). Minting a fresh Copilot token
from the account's GitHub OAuth refresh token resolved the failure. No token
or raw response body was written to this note.

For Cartethyia, keep the supported wire tiers as `efficiency`, `balance`, and
`intelligence`; show **Standard / High / Max** as UI labels if matching this
client. `selected_model.id` is the per-request chosen model, not the stable
tier name.

## Tool manifest delta

The pinned extension manifest registers **36** language-model tools. Relative
to the archived 0.70.0 map, the same tool names remain except these two are
absent:

- `copilot_installExtension`
- `copilot_runVscodeCommand`

Current names, grouped by role:

| Role | Registered tools |
|---|---|
| Read | `copilot_readFile`, `copilot_viewImage`, `copilot_listDirectory`, `copilot_readProjectStructure`, `copilot_getErrors`, `copilot_getNotebookSummary`, `copilot_readNotebookCellOutput` |
| Search | `copilot_searchCodebase`, `copilot_findFiles`, `copilot_findTextInFiles`, `copilot_searchWorkspaceSymbols`, `copilot_findTestFiles`, `copilot_getChangedFiles`, `search_subagent`, `explore_subagent` |
| Edit | `copilot_applyPatch`, `copilot_replaceString`, `copilot_multiReplaceString`, `copilot_insertEdit`, `copilot_createFile`, `copilot_createDirectory`, `copilot_editNotebook`, `copilot_editFiles` |
| Execute | `execution_subagent`, `copilot_runNotebookCell` |
| Web/GitHub | `copilot_fetchWebPage`, `copilot_githubRepo`, `copilot_githubTextSearch` |
| VS Code, memory, session | `copilot_getVSCodeAPI`, `copilot_createNewWorkspace`, `copilot_createNewJupyterNotebook`, `copilot_switchAgent`, `skill`, `copilot_memory`, `copilot_resolveMemoryFileUri`, `copilot_sessionStoreSql` |

The manifest gates some tools by settings. Notable defaults include execution
subagent enabled, search subagent disabled, skill tool disabled, and new
workspace creation enabled. `search_subagent` and `explore_subagent` are
mutually selected by the `exploreAgent.enabled` condition.

One static metadata mismatch needs separate verification before describing the
runtime model: the execution subagent's package description says it is powered
by Gemini 3 Flash, while `github.copilot.chat.executionSubagent.model` defaults
to `gpt-5.6-luna` and the tool has a 10-call limit. The description alone does
not prove which model a request actually uses.

## Evidence boundary / next proof

Bundle findings come from `package.json`, `package.nls.json`, and the pinned
extension bundle; the **Standard / High / Max** labels come from a
user-provided screenshot whose client version is unknown. Live API probes
confirm the legacy wire tiers are accepted and return model selections. The
remaining unverified detail is whether this exact screenshot build sends those
values when each UI option is selected; proving that requires a client-side
network capture with credentials redacted.
