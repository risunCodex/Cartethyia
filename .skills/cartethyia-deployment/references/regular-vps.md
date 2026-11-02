# Regular VPS

The VM holds the public IP on its own interface, so **you** install the reverse
proxy and it issues the certificate. There is no provider layer to negotiate
with, which makes this the simpler of the two bare-metal shapes.

Do the [shared provisioning](../references/shared-provisioning.md) first.

The shell examples below assume `set -euo pipefail`; stop on a failed download,
checksum, command, or validation rather than continuing into service changes.

## 1. Point DNS at the VM before starting Caddy

ACME cannot issue unless the domain already resolves to this host. Confirm
**from the host**, not from your laptop:

```bash
getent hosts <domain>   # must equal the VM's public IP
```

## 2. Install Caddy

The Cloudsmith apt repo has repeatedly failed signature verification
(`NO_PUBKEY ABA1F9B8875A6661`), including via its own `setup.deb.sh`. On a
single box the release binary is more reliable:

```bash
ARCH=$(dpkg --print-architecture)
case "$ARCH" in
  amd64) CADDY_ARCH=x86_64 ;;
  arm64) CADDY_ARCH=arm64 ;;
  *) printf 'Unsupported Caddy architecture: %s\n' "$ARCH" >&2; exit 1 ;;
esac
curl -fsSL -o /tmp/caddy-checksums.txt \
  "https://github.com/caddyserver/caddy/releases/download/v2.9.1/caddy_2.9.1_checksums.txt"
curl -fsSL -o /tmp/caddy.tar.gz \
  "https://github.com/caddyserver/caddy/releases/download/v2.9.1/caddy_2.9.1_linux_${CADDY_ARCH}.tar.gz"
grep "  caddy_2.9.1_linux_${CADDY_ARCH}.tar.gz$" /tmp/caddy-checksums.txt \
  | (cd /tmp && sha256sum -c -)
tar -xzf /tmp/caddy.tar.gz -C /tmp caddy
install -m 0755 /tmp/caddy /usr/bin/caddy
rm -f /tmp/caddy /tmp/caddy.tar.gz /tmp/caddy-checksums.txt
caddy version
```

Abort if the official release checksum is missing or does not match. Never
replace it with a checksum calculated from the downloaded archive itself.

A binary install does **not** create `/etc/caddy` or the `caddy` user. Create
both before writing the Caddyfile, or the unit fails on a missing path:

```bash
if [ -f /etc/caddy/Caddyfile ] && ! grep -q '^# Cartethyia managed' /etc/caddy/Caddyfile; then
  printf 'Refusing to overwrite an unmanaged Caddyfile\n' >&2
  exit 1
fi
mkdir -p /etc/caddy /var/log/caddy /var/lib/caddy
useradd --system --home /var/lib/caddy --shell /usr/sbin/nologin caddy
chown -R caddy:caddy /var/lib/caddy /var/log/caddy
```

## 3. Caddyfile (`/etc/caddy/Caddyfile`)

```caddyfile
# Cartethyia managed
<domain> {
	encode zstd gzip

	reverse_proxy 127.0.0.1:12800 {
		# SSE / streaming must not be buffered.
		flush_interval -1
	}

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "SAMEORIGIN"
		Referrer-Policy "strict-origin-when-cross-origin"
		-Server
	}

	log {
		output file /var/log/caddy/cartethyia.log
	}
}
```

No `local_certs`. It replaces the public certificate with a private one and is
not a valid public-site workaround in either topology.

**Installer-managed vs manual.** The installer writes a deliberately minimal
managed Caddyfile (`encode` + `reverse_proxy` with `flush_interval -1` only);
the security-`header` and `log` blocks above are for a hand-rolled setup. Do
not "restore" them into an installer-managed file — the managed file is
regenerated on rerun and the app sends its own security headers.

## 4. Caddy unit (`/etc/systemd/system/caddy.service`)

```ini
[Unit]
Description=Caddy reverse proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile
Restart=always
RestartSec=3
TimeoutStopSec=15
LimitNOFILE=1048576
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
```

`AmbientCapabilities=CAP_NET_BIND_SERVICE` is what lets a non-root process bind
:80 and :443.

## 5. Start and verify issuance

```bash
systemctl daemon-reload && systemctl enable --now caddy
journalctl -u caddy --since '-2min' --no-pager | grep -iE 'certificate obtained|challenge failed'
```

Pass condition is `certificate obtained successfully`. Confirm the certificate
is public:

```bash
echo | openssl s_client -connect <domain>:443 -servername <domain> 2>/dev/null \
  | openssl x509 -noout -issuer -subject
```

The issuer must be a publicly trusted CA expected for the domain. `Caddy Local
Authority` means the site is using a private certificate, not public TLS.

Then `https://<domain>/health` must return 200. See
[`proving-a-deployment.md`](proving-a-deployment.md) for why that alone is not proof.

## Historical verification example

One Ubuntu 24.04 deployment with Bun, PostgreSQL, and Caddy 2.9.1 obtained a
public certificate and completed a real upstream dispatch. This is a dated
example, not a guarantee for a new host; record the current host's evidence
instead of relying on old versions and addresses.

The egress resolver on this host was poisoned
(`www.codebuddy.ai` → `0.0.0.1`). Check
[`egress-and-dns.md`](egress-and-dns.md) before dispatching anything.
