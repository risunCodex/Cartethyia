# Remote debugging a live instance

Reference for `cartethyia-trace-replay`. Use when the failure is on a
deployment you do not have filesystem access to — a Railway/Render/VPS gateway,
a shared staging box — and you need the actual failing request before you can
fix anything.

This page is about **getting the evidence out of the instance**. Once you have
a verbatim payload, bisect with the parent skill's method. Do not
bisect on a guess; do not bisect on a payload you retyped.

## The two surfaces, and which one to use

| Surface | Auth | Use for |
|---|---|---|
| `/v1/*` | tenant API key (`CARTETHYIA_API_KEY`) | Replaying requests, confirming behaviour |
| `/console/api/*` | console session or tenant API key with the required scope | Listing and exporting recorded requests |

The console prefix is `/console/api` — it is mounted in
`src/console/console-router.ts` (`new Elysia({ prefix: "/console/api" })`) and
hard-coded in `console-router-guards.ts`. A probe against `/api/...` returns
`404`, which is easy to misread as "the endpoint does not exist here".

The gateway route and the console route use different scopes. A key limited to
`routing:invoke` cannot read `/system/usage/requests`; a tenant key with the
required `dashboard:read` scope can. Check the key's scopes rather than
assuming every gateway key has console access. A browser session can instead
use the dashboard's own Export/download path.

## Credentials

- Never print credentials or place them in command arguments. Read them from
  the existing protected environment/configuration in the same invocation or
  supply them through stdin/file descriptors. Shell variables do not persist
  between independent tool calls; that is not a reason to repeat a secret
  literally. Keep credentials out of tool output, process lists, logs, reports,
  and Git. `AGENTS.md` "Git and credentials" is the owner.

## Diagnose `000` before believing it

`000` is ambiguous — DNS, TLS, egress, or the client transport may be
responsible. Use an unauthenticated request or a second client and read the
HTTP result:

- `401` — the host answered; only the credential was missing or wrong.
- `404` — the host answered; the **route** is wrong, not the host.
- `000` with no response — transport is still unresolved; investigate DNS, TLS,
  egress, and the client itself before declaring the host unreachable.

An unauthenticated probe returning `401` is the cheapest way to tell these
apart. Do not report a host as unreachable on a single `000`.

## Step 1 — prove the instance answers

```bash
BASE="https://<host>/v1"
curl -s "$BASE/models" -H "Authorization: Bearer <key>"
```

The model list is ground truth for what the instance can route. A model id that
resolves locally but is absent here is a fixture gap, not a routing bug — and it
is the usual explanation for a `404` on a model name.

## Step 2 — find the failing request

Console endpoints (`src/console/observability/routes.ts`):

- `GET /system/usage/requests?period=…&limit=…&httpStatus=…` — the list the Usage
  page reads; filter by the HTTP status you are chasing.
- `GET /system/usage/requests/:requestId` — one record, with the error envelope.
- `GET /system/usage/requests/:requestId/download` — the retained request detail
  and payload metadata. Export it rather than retyping a body. Retention,
  redaction, or truncation may mean the exact original bytes are unavailable;
  say so instead of treating a partial capture as verbatim evidence.

Read `error.details` before theorising. `providerCode`, `providerStatus`, and
`raw` carry what the public `message` drops; `param` is often empty even when
the upstream knows exactly which field it rejected.

## Step 3 — replay verbatim

Send the exported body unchanged, with the failing client's `user-agent` so the
gateway takes the same path. Repeat it two or three times: a single 4xx may be
transient, and a baseline that does not repeat is not a baseline.

Then bisect with the parent skill's method: remove one thing at a time
to isolate the trigger, and compare the same request after fixing.

## Triage by status

| Status | Usual owner |
|---|---|
| `404` | Model id absent from `/v1/models`; alias or combo resolved to a name the provider does not serve |
| `400` | Often payload validation, but check provider code/message and model availability before bisecting |
| `401`/`403` | Key or scope, not the payload — **but see the egress rule below first** |
| `429` | Rate limit; lower probe counts |
| `503` | No healthy account upstream, or admission found no route |
| `504` | Often upstream/gateway timeout; distinguish it from cancellation and transport failure |

Repeated invalid model requests trip the IP strike window ("Warning n/10 … will
temporarily ban this IP"). Keep probe counts low and list `/v1/models` before
guessing ids.

### When a 403 survives every payload change, vary the egress IP

A 403 that survives controlled payload changes may be an egress restriction,
but that is still a hypothesis. Test it before spending another round on the
payload:

1. Run the **vendor's own client** from the same host. If it also fails, the
   contract is not yours to satisfy.
2. Repeat the same request through an authorized proxy with a different exit
   IP. A 200 there and a 403 direct supports an egress-address restriction.

Confirmed against OpenCode's free tier on 2026-10-17: 403 direct, 200 through a
proxy, with the request unchanged. A datacenter egress was refused outright, so
the provider needed an egress proxy rather than a header fix. Details:
[`opencode-free-tier.md`](opencode-free-tier.md).

## Hygiene

- Work in a scratch directory **outside the repo**; delete it when done. Leave
  no replay scripts or captured payloads in the tree.
- Payloads contain user content and credentials-in-flight. Do not paste a whole
  captured body into chat, a commit, or a report — extract only the fields under
  investigation.
- Stop any instance you started.
- Probe only an instance and key you are authorized to use.

## Report

State the host, which endpoint produced the evidence, the request id, the status
before and after, and the field you attributed it to. Say plainly what you could
not verify — for example, when the instance exposes only a subset of providers
and other upstreams on the same wire could behave differently.
