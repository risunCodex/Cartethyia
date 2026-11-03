# Deployment Security

How to run Cartethyia in production safely: the threat model, built-in security
features, supported network topologies, DDoS hardening, monitoring and incident
response, backup/recovery, and the Docker packaging.

> Placeholders (`<...>`) mark values you must fill with your own addresses,
> domains, and secrets. Never commit real IPs or credentials.

---

## 1. Threat model

A public gateway is attacked on several axes. The controls in this document map
to them:

| Threat | Main defense |
| --- | --- |
| DDoS L3/L4 (SYN/connection floods) | Cloudflare edge, kernel (sysctl), iptables rate-limit/connlimit |
| DDoS L7 (request floods) | Cloudflare rate limiting / WAF, built-in abuse bans, request-body & idle limits |
| Brute-force SSH | key-only auth, fail2ban |
| Origin IP discovery | all-DNS-proxied, tunnel-only ingress, origin never published |
| Provider/upstream abuse | per-key admission (concurrency/RPM/token budgets), provider max-inflight |
| Credential theft | `CARTETHYIA_ENCRYPTION_KEY` at-rest encryption, key fingerprints, no secrets in docs |
| Application/SSRF | validated outbound fetch, egress pools, loopback bind |

---

## 2. Built-in security features

Cartethyia ships protections that require no extra tooling:

| Feature | Behavior |
| --- | --- |
| Loopback binding | The gateway should listen on `127.0.0.1:12800` and be fronted by a reverse proxy or a Cloudflare tunnel. It is not meant to be directly internet-exposed. |
| `CARTETHYIA_DRAIN_TOKEN` | Enables `POST /admin/drain`, protected by a loopback peer plus this token. Used for graceful shutdown/drain of in-flight streams. Unset disables the route. |
| `CARTETHYIA_PUBLIC_ORIGIN` | Required. Must match the browser-facing scheme/host/port. Keeps the console session cookie secure and valid through the proxy/tunnel. |
| `CARTETHYIA_ENCRYPTION_KEY` | Encrypts stored provider credentials at rest; only fingerprints travel in plaintext. Generate once, keep secret, never rotate casually. |
| `CARTETHYIA_DATA_DIR` | Data directory for SQLite (Lite), payloads, install id. Keep on a persistent volume. |
| `CARTETHYIA_INSTALL_ID_DIR` | Stable install identity directory; only hosters who need cross-restart identity touch it. |
| `CARTETHYIA_DISABLED_TASKS` | Comma-separated list to disable background tasks (e.g. `zcode-gift-claim`). |
| Request hardening | `maxRequestBodySize` (8 MiB) bounds ingress allocation before validation; `idleTimeout` (60s) caps keep-alive abuse / Slowloris. |
| Admission & quota | Per-key concurrency/RPM/token budgets enforced before dispatch; provider max-inflight enforced per account. Rejections are fast (no upstream call). |
| Abuse detection | `src/security/abuse.ts` rate-limits and temporarily bans abusive client addresses on failure patterns, independent of provider health. |
| Console session | Session cookie + CSRF protection; never accepts credentials from the dashboard bundle. |
| SSRF / egress | Outbound fetch is SSRF-validated; egress can be pinned to network pools. |
| Telemetry/content safety | Secrets scrubbed from logs; payload captures are bounded and retention-pruned. |

---

## 3. Network topologies

### Minimum — 1 VPS (all-in-one)

Everything on one host: gateway, dashboard, and database. Supported and complete.
See [Deployment — Minimum](deployment-minimum.md).

### Scaling out — 2 VPS (gateway + persistence)

For more traffic, isolation, or resilience, split roles:

| What | Where |
| --- | --- |
| Gateway, dashboard, tunnel | VPS A (edge) |
| PostgreSQL + PgBouncer + Redis | VPS B (persistence), reachable only over WireGuard |

```
Clients → Cloudflare edge → tunnel → cloudflared (VPS A, localhost) → gateway
              → WireGuard → PostgreSQL/PgBouncer/Redis (VPS B, private)
```

- WireGuard subnet `<WG_SUBNET>`: VPS A = `<WG_GATEWAY_IP>`, VPS B = `<WG_DB_IP>`.
- `DATABASE_URL=postgres://<DB_USER>:<DB_PASS>@<WG_DB_IP>:6432/cartethyia`
  (PgBouncer, transaction mode).
- `REDIS_URL=redis://:<REDIS_PASS>@<WG_DB_IP>:6379/0`.
- PostgreSQL/PgBouncer/Redis bind to loopback or the WireGuard interface only;
  never expose them to the public internet.
- SSH on both hosts: key-only, `PasswordAuthentication no`.

### Reverse proxy / TLS termination

Pick one public entry and stick to it:

- **Cloudflare tunnel** (recommended): TLS terminated at Cloudflare, no open
  ingress ports on the VPS, hides the origin IP.
- **Caddy / nginx on the VPS**: terminates TLS locally and proxies to
  `127.0.0.1:12800`; requires `12800` to stay loopback-only and an open `443`.

---

## 4. DDoS hardening

Defense in depth, edge to host. The edge (Cloudflare) carries the largest share.

### 4.1 Cloudflare edge

- Keep all public DNS records **proxied** (grey cloud OFF) so the origin IP
  (`<VPS_PUBLIC_IP>`) never leaks.
- Rate Limiting Rules for `/v1/*` and `/console/*` (e.g. 60 req/min/IP).
- Managed WAF on High; Bot Fight Mode on; Under Attack Mode during an active
  attack.
- IP Access Rules for abusive ASNs/regions if needed.

### 4.2 Kernel (sysctl)

`/etc/sysctl.d/99-ddos.conf`:

```ini
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_syn_retries = 3
net.ipv4.tcp_synack_retries = 2
net.ipv4.tcp_max_syn_backlog = 4096
net.core.netdev_max_backlog = 4096
net.core.somaxconn = 4096
net.ipv4.tcp_fin_timeout = 30
net.ipv4.tcp_max_tw_buckets = 16384
net.ipv4.tcp_tw_reuse = 1
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.all.log_martians = 1
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.icmp_ignore_bogus_error_responses = 1
net.ipv4.ip_local_port_range = 1024 65535
net.netfilter.nf_conntrack_max = 131072
```

Apply with `sysctl --system`.

### 4.3 Firewall (iptables)

Keep the default `INPUT DROP` policy and the persisting
`/etc/iptables/rules.v4`. Key hardening rules:

```bash
iptables -A INPUT -m conntrack --ctstate INVALID -j DROP
iptables -A INPUT -p tcp --syn -m conntrack --ctstate NEW \
  -m hashlimit --hashlimit-above 30/sec --hashlimit-burst 60 \
  --hashlimit-mode srcip --hashlimit-name synflood -j DROP
iptables -A INPUT -p tcp --dport 22 -m conntrack --ctstate NEW \
  -m connlimit --connlimit-above 8 --connlimit-mask 32 -j DROP
iptables -A INPUT -p icmp --icmp-type echo-request \
  -m hashlimit --hashlimit-above 5/sec --hashlimit-burst 10 \
  --hashlimit-mode srcip --hashlimit-name icmp -j DROP
iptables -A INPUT -p tcp --dport 12800 ! -i lo -j DROP
iptables -A INPUT -p tcp --tcp-flags ALL ALL -j DROP
iptables -A INPUT -p tcp --tcp-flags ALL NONE -j DROP
iptables-save > /etc/iptables/rules.v4
```

The `12800` loopback-only rule protects the gateway even if a proxy misroutes.
If the gateway listens on loopback only, the rule is a second belt.

### 4.4 Brute-force protection (fail2ban)

```bash
apt install -y fail2ban
```

`/etc/fail2ban/jail.local`:

```ini
[DEFAULT]
bantime  = 30m
findtime  = 10m
maxretry = 4
backend   = systemd
ignoreip  = 127.0.0.1/8 <WG_NETWORK> <ADMIN_NETWORK>

[sshd]
enabled  = true
port     = ssh
filter   = sshd
```

Monitor bans: `fail2ban-client status sshd`.

### 4.5 SSH hardening

```bash
# /etc/ssh/sshd_config.d/99-hardening.conf
PasswordAuthentication no
PermitRootLogin prohibit-password
MaxAuthTries 3
MaxSessions 4
LoginGraceTime 30
```

> Install your public key into `/root/.ssh/authorized_keys` **before** disabling
> password auth. Restart `sshd` only after verifying the key works.

### 4.6 Application

- Bind the gateway to `127.0.0.1:12800` (loopback).
- On the host firewall, never publish `12800` to the public internet; only the
  proxy/tunnel reaches it.
- Keep `CARTETHYIA_DRAIN_TOKEN` set so restarts drain gracefully instead of
  killing in-flight streams.

### 4.7 Patching

Install `unattended-upgrades` and enable it so security updates apply
automatically.

---

## 5. Monitoring & alerting

| What | How |
| --- | --- |
| Gateway health | `curl http://127.0.0.1:12800/health/ready` (expect `{"status":"ready","db":"connected"}`) |
| Gateway logs | `journalctl -u cartethyia -f` |
| Fail2ban | `fail2ban-client status sshd` → `Currently banned` |
| Firewall drops | `iptables -L INPUT -n -v` (look at the `hashlimit` / `DROP` counters growing) |
| Abuse/rate-limit events | scan `journalctl` for abuse/ban events; check the console error log |
| Cloudflare | analytics + security events dashboards (WAF/rate-limit hits) |
| Disk | watch the data dir growth (telemetry retention); alert before 80% |

Low-cost setup on a 2 GiB box: a daily `logwatch`/mail summary plus a cron
that greps `fail2ban-client status sshd` and `health/ready`. Avoid heavy agents
(need netdata only if you have headroom).

---

## 6. Incident response (mini runbook)

1. **Confirm it is an attack** — `journalctl -u cartethyia -e | tail`,
   `iptables -L INPUT -n -v | head`, Cloudflare analytics. Look for one source
   IP/ASN dominating, or SYN/conn counters spiking.
2. **Lock the edge** — enable Cloudflare **Under Attack Mode**, tighten rate
   limiting, add an IP Access Rule for the offending ASN/region.
3. **If origin is being hit directly** — check nothing forwards to `12800`
   except the tunnel; verify `nginx`/tunnel only listens on loopback; if the
   origin IP leaked, change it (new VPS IP / re-proxy all DNS).
4. **At host level** — the iptables hashlimit/connlimit and `DROP INVALID`
   rules are already working; verify counters and persist any manual ban:
   `iptables -A INPUT -s <ATTACKER_IP> -j DROP && iptables-save > /etc/iptables/rules.v4`
5. **SSH brute-force** — confirm `fail2ban` bans; if needed raise `bantime`
   or reduce `maxretry`.
6. **Aftermath** — note the timeline, which controls fired, and add the source
   IP/ASN to the Cloudflare block list permanently if it keeps coming back.

---

## 7. Backup & recovery

| Mode | What to back up | Command |
| --- | --- | --- |
| Lite | SQLite file + data dir | `tar -czf backup.tgz -C /opt/cartethyia data` |
| Full | PostgreSQL dump | `pg_dump -Z9 -h 127.0.0.1 -U <DB_USER> cartethyia > backup.sql.gz` |

Security notes:

- Keep backups **off the VPS** (object storage / another machine), encrypted.
- Include the config `.env` (or at least the non-secret parts) in your runbook;
  the encryption key must be recoverable or stored credentials cannot be read
  after a restore.
- Test a restore on a scratch instance before an incident.

---

## 8. Docker deployment

### Image

The repository ships a `Dockerfile`:

- **Builder:** `oven/bun:1.4.2-debian` (pinned to `.bun-version`), runs
  `bun install --frozen-lockfile`, dashboard build, then AOT + standalone binary.
- **Runtime:** `debian:12-slim`, runs as non-root `uid 10001`
  (dropped via `setpriv`), with `HEALTHCHECK` on `/health/ready`.
- **Exposes** `12800`, `STOPSIGNAL SIGTERM`, entrypoint repairs volume ownership
  then drops privileges.

### Compose

`docker-compose.yml` provides:

- `app` service: builds the image, `env_file` from `.env`, persistent volume
  `cartethyia-data:/app/data`, depends on `redis`, `restart: unless-stopped`.
- `redis` service: `redis:7.4.2-alpine`, **bound to `127.0.0.1:6379`** on the
  host, with a healthcheck.
- PostgreSQL is never bundled; Full mode reaches it via `DATABASE_URL`.

### Hardening beyond the defaults

```yaml
services:
  app:
    # Keep the port loopback-only when a tunnel/proxy on the same host fronts it
    ports:
      - "127.0.0.1:12800:12800"
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    read_only: true
    tmpfs:
      - /tmp
    mem_limit: 1g
    pids_limit: 256
    restart: unless-stopped
```

Notes:

- The image already drops to `uid 10001`; add `no-new-privileges` and drop all
  capabilities for defense in depth.
- `read_only: true` needs a tmpfs for `/tmp` (and the data volume mounted
  read-write).
- Resource limits (`mem_limit`, `pids_limit`) bound runaway usage.
- Store `.env` and volume data outside the image; keep them out of the image and
  git history.
