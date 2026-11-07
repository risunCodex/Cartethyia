# Buddy CLI identity

Buddy-family providers (`cb`, `cbcn`) present themselves to upstream as a
specific official client. Which one they claim is not cosmetic: the upstream
gates chat on it, and a request whose headers do not correspond to any real
client is what channel verification refuses.

## The two identities

| | Desktop | CLI |
|---|---|---|
| Sent by | the desktop app / VSCode extension | the official CLI (axios `RestOperations`, not the OpenAI Node SDK) |
| Browser headers (`origin`, `referer`, `accept-language`, `x-requested-with`, `x-codebuddy-request`) | yes | **no** |
| `Accept` | `application/json, text/event-stream` | `application/json` |
| Device token / machine & session ids | yes | **no** |
| `X-Agent-Intent` / `X-Agent-Type` / `X-Agent-Runtime` | no | `craft` / `main` / `other` |
| `x-stainless-*` SDK fingerprints | no | **no** (CLI uses axios; no OpenAI SDK fingerprint) |
| IDE headers (`x-ide-name`, `x-ide-type`, `x-ide-version`, `x-domain`) | desktop-implied | yes (CLI sends them too) |
| Trace parent (`b3` 4th field, `X-B3-ParentSpanId`) | no | yes |
| `X-User-Id` | account id | account id, or the literal `anonymous` |
| `User-Agent` | `CLI/<v> CodeBuddy/<v>` | `CLI/<v> CodeBuddy/<v>` |

Both send `x-product: SaaS` and `X-IDE-Version`. The desktop product name
belongs in `x-ide-name` (`CodeBuddy`), not in `x-product`.

## Opt-in, and why

**No provider uses the CLI identity by default.** Identity is the one header
where being wrong has a cost beyond a failed request: a mismatched identity can
get an account blocked upstream. So the selector defaults to the desktop
contract every provider already sends, and a provider only changes when:

- an account carries `cliIdentity: true` in its auth state — precedence over
  the provider default, because the upstream recorded the identity at login; or
- a caller passes the flag explicitly.

Leaving it unset leaves every header byte-identical to before the selector
existed. The header set lives in `buddy-cli-headers.ts` and the selection in
`buddy-identity.ts`; the per-provider builder is `codebuddyHeaders`.

## Known gap

`x-conversation-request-id` is regenerated per request. The reference holds it
stable across retries and failover within one user send, so the backend
aggregates them into one record instead of fragmenting. This gateway has not
adopted that yet.

## Where to change it

| Concern | File |
|---|---|
| Identity selection and `X-User-Id` | `src/providers/integrations/buddy/buddy-identity.ts` |
| CLI-only headers (agent envelope, SDK fingerprints, trace parent) | `src/providers/integrations/buddy/buddy-cli-headers.ts` |
| CodeBuddy per-request headers | `src/providers/integrations/buddy/codebuddy/shared.ts` |
| Conversation and tracing family | `src/providers/integrations/buddy/buddy-conversation-headers.ts` |
