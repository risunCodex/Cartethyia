# Providers — per-family notes

Wire-level notes for each provider family: what is non-standard, what is
verified, and what bites. The architecture — layers, credentials, discovery,
quota machinery — lives in
[providers-architecture.md](providers-architecture.md).

Verified in code only. `bespokeWire` = the adapter frames its own protocol, not a canonical codec (`provider-metadata.ts`).

| Family | What is non-standard |
| --- | --- |
| kiro | Bespoke (`provider-metadata.ts`). AWS EventStream wire over the Kiro runtime service (`https://runtime.{region}.kiro.dev/generateAssistantResponse`), no chat-shaped endpoint; reasoning arrives as its own event or `<thinking>` markers in text. Browser PKCE only (IdC/Builder-ID via AWS SSO OIDC `authorization_code` + loopback; social via the vendor's sign-in service). |
| cursor | Connect-RPC bidirectional Run stream (`agent.v1.AgentService/Run`) over HTTP/2, `RunSSE` + `BidiAppend` on the HTTP/1 fallback; codec generated from `vendor/proto/cursor/agent.proto`. Relay-only: native tools are disabled server-side (`x-cursor-agent-allowed-tools`), caller tools ride the `requestContext` handshake, and held `mcp_args` calls park the Run (heartbeats keep its counted batch open) until the next request's results resume it in-band — exact model + wire-id + conversation + result-coverage contract, otherwise the turn rebuilds from history. Model identity is a pair: legacy slug in `model_details`, rich base id + parameter tuple in `requested_model`; reusing one string trips `BAD_MODEL_NAME`. History is SHA-256 blob records served over the KV channel; the server's own checkpoint records replay byte-for-byte under the same wire route + history digest. Quota pairs `cursor.com/api/usage-summary` (cookie auth, USD cents) over the legacy `/auth/usage` buckets (bearer); classic plans are percent-only rails. See `documentation/features/08-cursor-provider.md`. |
| github | Base URL is only a fallback: the real host comes from the Copilot token's `proxy-ep` claim per dispatch. Short-lived token, real refresher. The account label is the GitHub login, read from `api.github.com/user` with a plain user agent — the Copilot client headers draw a 400 there, and a missing login makes every account share one label so the next login replaces the row. The device dialog polls on one timer and waits out `slow_down`; a second poll inside GitHub's interval burns the device code. |
| antigravity | Google OAuth, but the wire is a Gemini payload wrapped in an agent envelope POSTed to `v1internal:{generate,stream}GenerateContent` — no per-model path. Image generation uses the same envelope with `responseModalities: ["IMAGE"]`; `/v1/search` adds Google Search grounding. |
| muse | Device-code login yields an OAuth token, exchanged by `POST /muse-code/key` for the `api_key` the backend accepts; the stored `oauth` secret is a `{oauthAccessToken, apiKey}` JSON blob. |
| meta | A plain developer-dashboard API key, no OAuth (`src/providers/registry/capabilities-*.ts`, `meta` row). |
| claude / codex | Subscription OAuth on Messages / Responses. Codex also serves websearch; its image path is a Responses `image_generation` tool on a chat carrier, without the chat identity envelope. A catalog row is not an entitlement — a ChatGPT account can reject the tool. |
| gemini | `x-goog-api-key` header, per-model `:generateContent`/`:streamGenerateContent` paths; not OpenAI-shaped. Image generation uses the same path. |
| xai / grok | Same issuer and JWKS, different surfaces: `grok` is the free Grok Build CLI proxy, `xai` is the paid API (`provider-metadata.ts`, `grok`/`xai` rows). |
| kilo | Resells the OpenRouter catalog behind a `{accessToken, orgId}` JSON credential. No refresh grant. |
| qoder | Device flow whose refresh endpoint answers 403; no refresher. Two realms (`qoder`, `qodercn`) with separate gateways, OAuth clients, and rosters. Upstream keys are opaque slots (`dfmodel`, `cmodel`), so the catalog publishes caller-facing names instead (`deepseek-v4.1-flash`, `cantus`); dispatch translates them back — see `integrations/qoder/qoder-virtual.ts`. `/model/list` states no output limit, so ceilings come per row. Free tier is read from upstream's own `is_free`, not hardcoded. Transport split: free `lite` slots use the legacy COSY surface; billed slots use gRPC (`ChatCompletionStream`, the only surface that carries 1M-token context). The gRPC wire is protobuf — request `tools`/`tool_choice`/`parallel_tool_calls` and response `delta.tool_calls` use Struct/Value wrapper shapes, not OpenAI JSON (see `documentation/research/qoder/archive/qoder-research-archive-2026-11-11.zip` — `2026-11-05-qoder-tool-calling.md` — and `documentation/research/qoder/2026-11-05-qoder-model-matrix.md`). |
| trae / traecn | Two disjoint surfaces that share no model id: chat (`/api/ide/v1/llm_raw_chat`, keyed by `model_name`) and agent (`/api/agent/v3/llm_utils_chat`, keyed by `config_name` + `config_source` + `function: solo_agent`). The intl catalog is agent-only, because neither surface serves the other's ids. Current behavior is owned by the Trae provider implementation and its tests. |
| cline | Discovery reads only `recommended` + `free` — the pass roster would write subscription rows an operator's account can only 401 on. |
| openrouter / zcode | PKCE ends by minting a **durable API key**, not an access token; no refresher. |
| xiaomi-mimo | Two ids: `xiaomipg`, `xiaomitp`, both key-based. MiMo Studio browser-cookie login is not supported. |
| cb / cbcn | One billing system: `BUDDY_PROVIDER_IDS` names the family for health, request prep, and daily check-in. CN mirrors intl on `copilot.tencent.com` plus recent CN model additions. See the [catalog-fetch procedure](../../.skills/cartethyia-provider-catalog/SKILL.md#fetch-a-buddy-model-catalog). |
| opencode / opencode-zen / opencode-go | Three tiers on `opencode.ai`: free and Zen dispatch on `/inference/v1` (free: `requires_account: false`, `ipScopedRateLimit: true` — 429 cools the pool, not the account; Zen: billed), Go on the separate `/zen/go/v1` base. The `/zen/v1/models` listing is the catalog surface for free/Zen (`/inference/v1/models` answers 404), see `integrations/opencode/provider.ts`. A dispatch carrying more than 128 tool definitions is clamped before it is sent: definitions the conversation already called are kept, and the rest fill the remaining slots in their original order. Upstream refuses the unclamped list. Every tier's dispatch carries the client-identity fingerprint (`integrations/opencode/fingerprint.ts`). The free tier requires the 11-tool agent set and `stream: true`; it sends **no `Authorization` header** (the anonymous `Bearer public` sentinel is no longer sent — verified live 2026-11-02: the same captured flow answers 200 with or without it). Upstream refuses a free dispatch outright from a blocked egress IP — a datacenter address is refused, so free-tier dispatch needs an egress proxy, not a header change. |
| exa / parallel | `serviceKinds: ["websearch"]` only; served by `/v1/search`, never the chat pipeline. No account uses the public MCP; a stored API key uses the higher-limit HTTP API. |
| deepseek | Bundled API-key provider on the Anthropic Messages adapter at `/anthropic/v1/messages`; its OpenAI-compatible `/v1/models` discovery is separate (`deepseek.ts`). |
| mistral, fireworks, nvidia, gmi, ollamacloud | Shared configured OpenAI-compatible spec rows. |
| factory | WorkOS device code against a proxy that multiplexes four wires by model family (`dispatch` branches on `wire_family`). Credential `{accessToken, orgId}` — org id is the JWT's `external_org_id` claim, sent as `X-Factory-Org-Id`; host comes from the account's residency region. Real refresh grant exists, and the token request is issued in the client because the shared helper drops `refresh_token`. |
| cloudflareai | A gateway, not a model host: account and gateway slugs are path segments of the base URL, stored with the token, built at dispatch time. Auth is `cf-aig-authorization`. Messages wire only. No refresh grant. |
| alibabacp | International and mainland-China plans on different hosts with non-interchangeable keys; region stored with the token and resolved to a base URL ending `/compatible-mode/v1`, so endpoint paths are unprefixed. No refresh grant. |
| dashscope | Alibaba's mainland DashScope coding host, plain bearer on `https://coding.dashscope.aliyuncs.com/v1`. Distinct from `alibabacp` (Token Plan on `token-plan.*.maas.aliyuncs.com`). Live `/v1/models` discovery plus an 8-row static floor. |
| factory / cloudflareai / alibabacp catalogs | Static rosters in `integrations/*/*-models.ts`; none publishes a listable endpoint, so the catalog is the list. Limits come from the base catalog via `models-dev-catalog.ts` remaps; capability is declared per row. |

## Commandcode Go and ZCode Start Plan

Commandcode Go is a subscription tier of `commandcode`, not another provider.
Requests use the CLI generation envelope and NDJSON response. Quota reads are
organization-scoped; monthly allowance, purchased/free credits, and independent
five-hour/weekly limits remain separate. Purchased credits are not capped by
the monthly plan allowance. An unknown allowance cap does not erase a known
spendable balance.
An upstream reset timestamp of zero means no reset deadline is available, not
a reset in January 1970.

`zcode-start` (displayed as **ZCode Start**) is separate from `zcode` (the regular Z.AI Coding Plan). Sign in
with its device flow or import the ZCode login JWT; a Coding Plan API key or
the short-lived Z.AI access token is not interchangeable. There is no refresh
grant: sign in again if the session is expired or revoked. Requests use
`https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages`, bearer auth,
ZCode identity headers and the three-block client prompt. Caller instructions
are appended inside the third block, not discarded or sent as a fourth block.

Quota reads `GET /api/v1/zcode-plan/billing/balance`. Each balance keeps its
`capabilities` model IDs, owning `user_plan_id`/`plan_id`, entitlement period,
`total_units`, `used_units`, `remaining_units`, and activation/expiry times.
Alternative grants can fund the same model; a spent grant cannot disable an
unrelated model. Future grants show **Not started yet** and their start time,
but cannot fund requests. Expired grants cannot fund requests even if their
last reported remaining amount was positive. Missing usage is unknown, not zero.
The dashboard summarizes multiple Start Plan grants as **Start +N** (no popup),
with full upstream names in the badge title. Window headings show grant and
period without a model caption. Known names are displayed as **Start** and
**Global Build**; other promo/referral names remain unchanged. Stored quota
and routing identities are not renamed. Future windows stay visible.
Timeout, network and unreadable-JSON quota failures remain distinct; a timeout
does not advance the account failure streak.
A successful balance is authoritative: a model with no matching grant is not
eligible. Dashboard availability follows the same grant lifetimes and treats
same-model grants as alternatives, rather than showing a spent sibling as an
account-wide zero balance.
Generation business-error envelopes are failures even when the upstream HTTP
status is 200; they must not produce successful empty completions.

The **Claim gifts** button in the provider account row is an explicit manual
action; quota cards do not expose gift claims. It reads marketing banners and billing preview, then
posts each offered `plan_id` to `/api/v1/zcode-plan/billing/claim`. Claim codes
`0`, `1003`, and `3007` mean claimed, already claimed, and CAPTCHA respectively.
Complete CAPTCHA in the ZCode app. Unknown/unreadable replies are failures;
mixed outcomes are partial, never an unconditional success. A successful
no-data preview is a valid empty list. New grants invalidate both the live cache
and the persisted quota snapshot used after a cold start.

Automatic claims are **off by default**. Set `CARTETHYIA_ZCODE_AUTO_CLAIM=true`
to opt active accounts in; the first pass runs after 24 hours and repeats daily.
Each daily pass drains the eligible accounts in bounded pages; the page size
does not defer the remaining accounts to another day.
`CARTETHYIA_DISABLED_TASKS=zcode-gift-claim` still disables that task. Manual
claim remains available independently. Disabled/cooling accounts are not
automatically claimed, and this scheduler does not enable them.

### Upstream reference

The [Magpie ZCode integration](https://github.com/yetone/magpie) and its
[`opencode-zcode-auth` package](https://www.npmjs.com/package/@magpie-community/opencode-zcode-auth/v/0.1.42)
document the billing shapes, `capabilities` model mapping, legitimate empty
preview and claim codes. Magpie's `-Trial` suffix distinguishes gifts from
Coding Plan entries in its combined picker; upstream requests use raw model
IDs. The separate `zcode-start` provider keeps those raw IDs without a fallback
that spends the regular Coding Plan.

Commandcode plan entitlement is model-specific: a `MODEL_NOT_IN_PLAN` refusal
rests the selected model rather than invalidating the account. The provider's
[Go plan roster](https://commandcode.ai/docs/plans/go) is the entitlement
reference, not the unfiltered model catalog.
