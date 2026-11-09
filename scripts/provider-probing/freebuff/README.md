# Freebuff probing

Live wire probes for the Freebuff Desktop 0.0.201 upstream, reconstructed from
the app bundle (`D:\tmp\unpacked\freebuff\app\resources\orchestrator\orchestrator.js`).

## Wire map (prod)

| Surface | Endpoint | Notes |
|---|---|---|
| Code login | `POST /api/auth/cli/code` | body `{fingerprintId}` → `{loginUrl, fingerprintHash, expiresAt}` |
| Login poll | `GET /api/auth/cli/status` | `fingerprintId` + `fingerprintHash` + `expiresAt` → `{user:{authToken}}` |
| User info | `GET /api/v1/me?fields=…` | `Authorization: Bearer <token>` |
| Device keys | `POST /api/v1/freebuff/device-keys` | body `{publicKey, client:"desktop"}` → `{keyId}`; Ed25519 |
| Model catalog | `GET /api/v1/freebuff/models` | headers: `x-freebuff-catalog-protocol: 1`, `x-freebuff-client: desktop` |
| Session admission | `POST /api/v1/freebuff/session/admission` | model/instance headers; device-signed |
| Session status | `GET /api/v1/freebuff/session` | heartbeat variant uses `x-freebuff-heartbeat: 1` |
| Session release | `DELETE /api/v1/freebuff/session` | `x-freebuff-instance-id` + `x-freebuff-multi-session: 1` |

Hosts (prod): API/AUTH `https://www.codebuff.com`. The staging hosts observed in
the bundle (`staging-auth.freebuff.com`, `staging-*.freebuffweb.site`) are
gated behind env overrides.

## Running

OAuth capture (opens a browser; writes the token to scratch):

```sh
bun scripts/provider-probing/freebuff/freebuff-oauth-capture.mjs
```

Probe with a captured token:

```sh
bun scripts/provider-probing/freebuff/freebuff-probe.mjs --creds=D:/tmp/scratch/freebuff-probe/credential.txt
bun scripts/provider-probing/freebuff/freebuff-probe.mjs --token=... --model=openai/gpt-6-luna
bun scripts/provider-probing/freebuff/freebuff-probe.mjs --list-models
```

Flags:

| Flag | Meaning |
|---|---|
| `--out <path>` | credential output path (capture) |
| `--token <t>` | inline token (probe) |
| `--creds <path>` | read token from a capture file (probe) |
| `--model <id>` | model to admit (default `deepseek/deepseek-v4-flash`) |
| `--list-models` | print bundled wire model ids |
| `--no-browser` | do not auto-open the browser (capture) |
| `--no-release` | keep the admitted session open (probe) |
| `--show-secret` | print the full token |

Tokens are never printed unless `--show-secret`. Only a short prefix is shown;
use `--out`/`--creds` to move tokens through files.
