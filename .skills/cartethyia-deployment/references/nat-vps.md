# NAT VPS (provider-managed forwarding and TLS)

A NAT VPS has a private interface address and selected public ports forwarded
by the hosting provider. The public IP belongs to the provider, not necessarily
to the VM. Provider offerings such as "Caddy Auto-SSL" normally mean the
provider owns the reverse proxy and certificate lifecycle.

Prefer `scripts/install.sh --vps --nat ...`. Cartethyia's NAT target does not
install or configure Caddy. Use [shared provisioning](shared-provisioning.md)
for the application, then configure forwarding in the provider's control panel.

## 1. Establish the actual topology

A private interface plus a different public egress address supports NAT, but
missing or timed-out detection is **unknown**, not permission to guess. Confirm
the provider's forwarding/TLS model and the external port before changing the
host. See the parent skill's detection procedure.

## 2. Configure the provider boundary

Forward the provider's external port to the same application port on the VM.
The current installer has one `--port`; it does not model separate internal
and external ports. The public origin must match the browser-facing scheme,
host, and external port exactly:

```bash
bash scripts/install.sh --vps --nat --lite \
  --port 12800 --public-origin https://app.example.com:12800
```

If the provider requires different internal and external ports, do not use the
installer's NAT shortcut as though it modeled that mapping. Configure/build
manually: set `PORT` to the internal listener and
`CARTETHYIA_PUBLIC_ORIGIN` to the external URL, then verify both sides. Do not
infer public reachability from the install flag. Preserve explicit
`TRUSTED_PROXY_CIDRS`. Add the provider proxy's trusted address range only
when its request-forwarding behavior is known; an unspecified proxy network is
not automatically trusted.

The application still needs to be reachable by the provider's forwarder. The
gateway's default listener is not loopback-only. Do not force a loopback bind
when the forwarder runs outside the VM; it cannot connect to the VM's
loopback. Restrict exposure with the provider/host firewall and verify the
actual forwarding path.

## 3. Do not manage another proxy

- Do not install a second Caddy or compete for the provider's public ports.
- Do not add `local_certs` to a public-site configuration; a private CA is not
  a substitute for the provider's public certificate.
- Do not overwrite an existing proxy configuration that Cartethyia does not
  own.
- Do not assume NAT needs the Regular VPS Caddy/TLS procedure.

If the provider gives no forwarding/TLS service and the VM actually owns its
public IP, reclassify the host instead of forcing the NAT path.

## 4. Verify each boundary separately

Inside the VM:

```bash
systemctl is-active cartethyia
curl -fsS http://127.0.0.1:12800/health/ready
ss -lnt
```

This proves only local process/readiness and listener state. It does **not**
prove forwarding, public DNS, external TLS, or provider upstream access.

From an outside client, probe the exact public origin and inspect the presented
certificate and `/health/ready`. A successful public HTTPS response verifies
that path; a failure remains a provider/network boundary until isolated. Do not
inspect `journalctl -u caddy` as a substitute when Caddy is provider-managed.

When the public path works, follow
[`proving-a-deployment.md`](proving-a-deployment.md) for an authenticated model
request. If outside access is unavailable, report external forwarding and TLS
as unverified rather than claiming success from loopback.

## Historical evidence is not a current guarantee

Previous provider-specific hosts and certificate observations are examples,
not a universal NAT contract. Provider products and forwarding rules differ;
verify the current host and control plane before applying them.
