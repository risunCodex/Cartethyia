# Security Policy

Cartethyia is a self-hosted gateway that proxies credentials, biling, and
provider traffic. Security bugs in it can expose API keys, tenant data, or
allow abuse of paid provider accounts — please take responsible disclosure
seriously.

## Supported Versions

| Version | Supported |
| --- | --- |
| 2.x (release branch) | ✅ Active |
| < 2.0 | ❌ No |

Security fixes are backported to the latest release line. The `main` branch
receives fixes immediately; release branches receive them on the next patch
release.

## Reporting a Vulnerability

**Please do not open a public issue for a security vulnerability.**

Report it privately via the repository's GitHub Security Advisory:

1. Go to
   [github.com/risunCodex/Cartethyia/security/advisories](https://github.com/risunCodex/Cartethyia/security/advisories).
2. Select **New draft security advisory**.
3. Include as much of the following as you can:
   - Affected version(s) and the commit or release you tested.
   - A minimal reproduction: request shape, provider/model involved, and the
     expected vs. observed behavior.
   - Impact: what an attacker can do, and what data or credentials are at risk.
   - Suggested fix, if you have one.

What we ask:

- Give us a reasonable window to triage and fix before public disclosure
  (default: 90 days from the report).
- Do not test against live production deployments or third-party provider
  accounts you do not own. The repository's own `docker-compose.test.yml` is a
  safe local harness.
- If you have already confirmed the issue, include the evidence (redacted —
  never paste live credentials or tokens).

What you can expect:

- Acknowledgment within 5 business days.
- A status update at least weekly while the issue is open.
- Public credit in the release notes when the fix ships, unless you prefer to
  remain anonymous.

## Scope

In scope:

- The gateway itself: request handling, routing, provider adapters, quota and
  cooldown enforcement, telemetry, and the console API.
- The dashboard web frontend (XSS, CSRF, authorization issues).
- The installer, CLI, Docker image, and deployment scripts.

Out of scope (not vulnerabilities of Cartethyia):

- Vulnerabilities in upstream providers or in third-party software you run
  alongside it (PostgreSQL, Redis, reverse proxies).
- Weak credentials, exposed secrets, or insecure deployments that are operator
  configuration mistakes.

## Safe Harbor

Research conducted in good faith, within the scope above and against systems
you own or have permission to test, is welcome. We will not pursue legal action
against reporters who act in good faith and follow this policy.
