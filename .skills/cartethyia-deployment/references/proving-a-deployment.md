# Proving a deployment

`/health` returning 200 proves only that the process is up — not DNS, not TLS,
not the database, not upstream auth. A deployment is proven by one real
dispatch through an enrolled account.

## Layer 1 — units and listeners

```bash
systemctl is-enabled cartethyia && systemctl is-active cartethyia
# Regular VPS with Cartethyia-managed Caddy only:
systemctl is-enabled caddy && systemctl is-active caddy
ss -lnt | grep -E ':12800|:443'
```

On a regular VPS with managed Caddy, both units must be enabled to survive a
reboot. NAT does not install/manage Caddy through Cartethyia; `--no-caddy`
also leaves the external proxy outside this check. Match the configured port
rather than assuming the default 12800.

## Layer 2 — TLS from a real client

```bash
python3 -c "import urllib.request;r=urllib.request.urlopen('https://<domain>/health',timeout=20);print(r.status)"
```

Windows `curl` printing `000` next to a Python 200 means the deployment is fine
— see [`egress-and-dns.md`](egress-and-dns.md).

## Layer 3 — the gateway answers with your key

```bash
curl -s http://127.0.0.1:12800/v1/models -H 'authorization: Bearer <key>'
```

An empty `data[]` is normal **before** accounts are enrolled: the model list is
per-tenant and grows as accounts are added. It is not a routing bug.

## Layer 4 — dispatch a real request

```bash
curl -s --max-time 120 \
  -H 'content-type: application/json' -H 'authorization: Bearer <key>' \
  -d '{"model":"<providerId>/<model>","stream":false,"max_tokens":64,"messages":[{"role":"user","content":"Reply with the single word: ok"}]}' \
  http://127.0.0.1:12800/v1/chat/completions
```

A loopback 200 proves request parsing, the selected route, database-backed
account/model state needed by that dispatch, and upstream auth/provider reach.
It does not separately prove public DNS, external TLS, or NAT forwarding;
verify those through the public origin from an outside client.

Qualify the model as `<providerId>/<model>`. An unqualified id matching two
providers returns `ambiguous_model` with the candidate list.

Run it two or three times. A single 4xx can be transient, and a baseline that
does not repeat is not a baseline.

## Enrolling an account

Console routes live under `/console/api` (mounted in
`src/console/console-router.ts`; a probe against `/api/...` returns 404, which
is easy to misread as "the endpoint does not exist"). A tenant API key works on
the read paths.

Provider capability decides how an account can be added — check **before**
trying, because the answer is per-provider:

```bash
curl -s -H 'authorization: Bearer <key>' http://127.0.0.1:12800/console/api/providers \
  | python3 -c "import sys,json;[print(p['providerId'],p['oauthFlows']) for p in json.load(sys.stdin)]"
```

- `import: true` →
  `POST /console/api/providers/:providerId/oauth/import` with
  `{ credential, accountLabel }`.
- `import: false, device: true` →
  `POST /console/api/providers/:providerId/oauth/device/start` returns a
  `verificationUri` that **a human must open in a browser**. Do not automate
  the provider's authorization or consent. Give the URL to the authorized user
  and follow the flow's polling/completion procedure.

Check the Buddy family's current `oauthFlows`; do not assume that a token on
disk is enrollable when import is disabled.

Send credentials on stdin (`--data-binary @-`) rather than in the command line,
so they do not land in the process list or shell history.

## Reading a failure

When a dispatch fails, get the record rather than guessing:

```bash
curl -s -H 'authorization: Bearer <key>' \
  'http://127.0.0.1:12800/console/api/system/usage/requests?limit=200' \
  | python3 -c "import sys,json;[print(i['requestId'],i.get('model'),i.get('httpStatus'),i.get('errorKind')) for i in json.load(sys.stdin).get('items',[]) if i.get('httpStatus')!=200]"
```

Read the retained error details for the upstream code/status and category.
Group by `httpStatus` rather than eyeballing: a failure hides easily among a
screen of 200s. Payload retention and redaction may limit what is available.

## Report

State the host, the topology and how you identified it, the domain, and the
status before and after. If you never dispatched a real request, say so plainly
rather than letting a green `/health` stand in for proof.
