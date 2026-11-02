# WorkBuddy AI desktop — unpacked wire audit (Electron app.asar)

Source: installed WorkBuddy AI desktop at
`C:\Users\Aria\AppData\Local\Programs\WorkBuddyAI` (shortcut target
`WorkBuddyAI.exe`). Electron app: `resources/app.asar` (96 MB) unpacked to
`D:\tmp\workbuddy-unpacked` with the repo's `bun scripts/tools/asar-unpack.mjs`
(10,063 files). Native/extracted resources live in `resources/app.asar.unpacked`.
All observations dated 2026-11-02; revalidate before treating as current.

## 0b. Live verification: qimei36 / Turing device headers per provider

Verified with `scripts/provider-probing/buddy/codebuddy-adapter-capture.ts`
(records the real adapter's outbound wire off-network) using the `cb` account
from `cb-accounts-2026-11-02T06-10-27-996Z.json` (auth_state carries an explicit
`qimei36`; bundled Turing SDK is loadable).

| Provider | identity | `X-Device-Id-List` (qimei36) | `X-Device-Token` (Turing) | `X-User-Id` |
|---|---|---|---|---|
| `cb` (intl) | CLI (`cliIdentity: true`) | absent | absent | JWT `sub` |
| `cbcn` | desktop | sent (`auth_state.qimei36`) | sent (SDK token) | absent |
| `workbuddy` | desktop | sent | sent | internal account id |
| `workbuddycn` | desktop | sent | sent | internal account id |

Conclusions:
- qimei36 and the Turing device token are really sent, but only on the desktop
  identity (cbcn / workbuddy / workbuddycn). The intl `cb` adapter forces
  `cliIdentity: true`, so it returns the CLI header set before device headers —
  no device token, no qimei36 (matches the reference CLI, which has no device).
- The explicit `auth_state.qimei36` wins over derivation (the exported account's
  `29e515ed…` is used verbatim).
- `X-Custom-Channel-Id` is never sent on chat (it is login/auth-state only), so
  no adapter change is needed for it.

Live chat: `deepseek-v4.1-flash` and `auto` (→ `default-model`) both stream
HTTP 200 with the CLI identity + conversation headers + the JWT; the body
(`cache_retention: long`, `reasoning_summary: auto`, `reasoning_effort: high`,
`thinking.enabled`) is accepted upstream.

## 1. The desktop bundles the CodeBuddy CLI as its chat engine

`resources/app.asar.unpacked/cli/` is a full `@genie/agent-cli` install — the
same package published as `@tencent-ai/codebuddy-code` (bundled CLI version
2.161.0; `customPackage` publish config). It ships `bin/codebuddy`,
`dist/codebuddy-lite-wb.mjs`, `dist/lazy-lite-wb/`, `product.json`, vendor, and
node_modules. The Electron shell (`main/`, `renderer/`) handles login, windows,
and local services; the actual chat requests are made by this CLI daemon.

Consequence: **the desktop's chat wire is the CodeBuddy CLI wire already
audited** — same `POST https://www.workbuddy.ai/v2/chat/completions`, same
conversation/identity header family. The 2026-11-02 CodeBuddy CLI unpack audit
therefore covers the WorkBuddy desktop chat path.

## 2. WorkBuddy product config (`cli/product.json`)

- `productName: "WorkBuddy AI"`
- `endpoint: https://www.workbuddy.ai` (CN: `www.workbuddy.cn` ↔ `copilot.tencent.com`)
- `authentication.id: "workbuddy-desktop-ai"`, type `cli-external-link`,
  `usernameHeader: X-User-Id`, `tokenHeader: Authorization`, bearer token,
  `prefixPath: /plugin`.

## 3. Auth-state headers are login-only, not chat

`WorkbuddyAuthStateHeaderProvider` (`main/server.js`) builds:
- `X-Custom-Channel-Id: "unknown"` — always sent (channel constant is `unknown`);
- `X-Device-Token` — from `authService.getTuringDeviceToken()` (TuringShield),
  otherwise `X-Device-Token-Error`;
- `X-Device-Id-List: {"qimei36":"…"}` — only when qimei36 resolves (resolver or
  env `CODEBUDDY_QIMEI36`); omitted with a warning otherwise.

These are consumed by `AuthStateHeaderComposer.compose()`, which is called from
**`fetchAuthState` only** (login/`/v2…/auth/state`), not from chat requests. So
`X-Custom-Channel-Id` is a login-surface header, not a chat header.

## 4. Chat route and replay table (`main/server.js`)

Route table confirms:
- `chat.stream` → `POST /v2/chat/completions` (replay class `forbidden`, commit
  point `first-valid-token`);
- `config.fetch` → `/v3/config` and `/v1/config`;
- share/space API `/space/api/**`, `/v2/as/netdisk/**`.

Queue API (`main/node.js`):
- `POST /v2/chat/queue/status` (body `{model}`), `POST /v2/chat/queue/cancel`;
- headers: `X-Conversation-Request-ID` (required) + `X-Conversation-ID`
  (optional). Error codes `6020 WAITING`, `6021 FULL`, `6022 USER_LIMIT`.

Local custom models (`main/index.js`): served at `http://127.0.0.1:52741/v1/chat/completions`
(daemon), declared with `reasoning.defaultEffort: medium`, supported efforts
`low/medium/high`.

## 5. What the desktop chat does NOT carry

`main/server.js` (the shell) contains **no** `reasoning_summary`,
`cache_retention`, `prompt_cache_key`, or `x-stainless-*` literals. Those
belong to the CLI/agent gateway (audited in the CodeBuddy note), further
confirming that stainless fingerprints are not a chat-wire feature and that
`cache_retention` / `reasoning_summary` are CLI-gateway injections.

## 6. Turing / device configuration

- Channel id is read from `WORKBUDDY_TURING_CHANNEL_ID` env, falling back to the
  configured SDK `channelId` (400111 for WorkBuddy).
- The gateway's `turing-device-token.ts` already pins channel 400111 with
  product `WorkBuddy AI` / `CodeBuddy`, matching the desktop.

## 7. Adapter comparison (gateway vs desktop)

| Aspect | Desktop (unpacked) | Gateway workbuddy adapter | Match |
|---|---|---|---|
| Chat endpoint | `/v2/chat/completions` | `WORKBUDDY_CHAT_PATH` | ✅ |
| Origin / X-Domain | `www.workbuddy.ai` | `WORKBUDDY_DOMAIN` | ✅ |
| Auth | Bearer + `X-User-Id` | same | ✅ |
| Conversation headers | `X-Conversation-Request-ID` etc. | `buddyConversationHeaders` | ✅ |
| Device token | `X-Device-Token`/`-Error` (Turing) | `buddyDeviceTokenHeaders` | ✅ |
| qimei36 binding | `X-Device-Id-List` (auth-state) | `X-Device-Id-List` (desktop chat) | ✅ |
| `X-Custom-Channel-Id` | login-only (`unknown`) | not sent on chat | ✅ (no change needed) |
| UA | CLI daemon `CLI/<v> CodeBuddy/<v>` | desktop profile `WorkBuddy/… workbuddy-ai/… CLI/…`, CLI profile `CLI/…` | ⚠️ verify live |

## 8. Unverified / open

- Whether the live desktop chat sends the desktop UA or the bundled CLI UA
  (the daemon is the CLI, but the product config is WorkBuddy AI). A live
  capture via mitmproxy settles it.
- Whether chat requests carry device tokens (the shell sends them on auth-state
  only; the CLI daemon is a CLI identity and would not). The gateway currently
  sends device headers on the desktop identity — verify against a live chat.
- The bundled CLI version (2.161.0) vs the current npm latest (2.179.2) — the
  desktop lags the standalone CLI release.
