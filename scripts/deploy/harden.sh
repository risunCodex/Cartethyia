#!/usr/bin/env bash
# Cartethyia server hardening — nftables baseline, fail2ban, unattended
# upgrades, and swap sizing. Idempotent: safe to re-run; existing settings are
# kept or rewritten to the same values.
#
# Lockout prevention is built in, not hoped for:
#   - The firewall applies with a 120-second auto-revert guard. Open a SECOND
#     SSH session and run this script with --confirm-firewall before the guard
#     expires; if you cannot get back in, the firewall reverts by itself.
#   - fail2ban ignoreip captures the address this session came from.
#   - SSH auth configuration is never touched by this script.
#
# Usage:
#   harden.sh                 print the plan (no mutation)
#   harden.sh --apply         apply every step
#   harden.sh --confirm-firewall
#                             cancel the auto-revert guard from a verified
#                             second session (must run within 120s of --apply)
# Options: --swap-size <bytes|off>  override the computed swapfile size
set -uo pipefail

APPLY=0
CONFIRM=0
SWAP_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --confirm-firewall) CONFIRM=1 ;;
    --swap-size)
      [ $# -ge 2 ] || { echo "--swap-size requires a value" >&2; exit 2; }
      SWAP_OVERRIDE="$2"; shift ;;
    --swap-size=*) SWAP_OVERRIDE="${1#*=}" ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

log() { echo "[cartethyia-harden] $*"; }
die() { echo "[cartethyia-harden] ERROR: $*" >&2; exit 1; }
require_root() { [ "$(id -u)" = "0" ] || die "run as root"; }

GUARD_DIR=/run/cartethyia-harden
GUARD_CONFIRM="${GUARD_DIR}/firewall-confirmed"
GUARD_ROLLBACK="${GUARD_DIR}/rollback.nft"
NFT_CONF=/etc/nftables.conf

nft_conf_content() {
  cat <<'NFT'
#!/usr/sbin/nft -f
flush ruleset

table inet filter {
  chain input {
    type filter hook input priority 0; policy drop;
    iifname "lo" accept
    ct state established,related accept
    ip protocol icmp accept
    meta l4proto icmpv6 accept
    tcp dport 22 ct state new limit rate 6/minute burst 20 packets accept
    tcp flags & (fin|syn|rst|psh|ack|urg) == (fin|syn|rst|psh|ack|urg) drop
    tcp flags & (fin|syn|rst|psh|ack|urg) == 0x0 drop
  }
  chain forward { type filter hook forward priority 0; policy drop; }
  chain output { type filter hook output priority 0; policy accept; }
}
NFT
}

rollback_nft() {
  cat <<'RB'
#!/usr/sbin/nft -f
flush ruleset
RB
}

bytes_of() {  # "2G" | "512M" | bytes → bytes
  case "$1" in
    *G) echo $(( ${1%G} * 1024 * 1024 * 1024 )) ;;
    *M) echo $(( ${1%M} * 1024 * 1024 )) ;;
    *) echo "$1" ;;
  esac
}

human() {  # bytes → MiB/GiB
  local b=$1
  if [ "$b" -ge $((1024*1024*1024)) ]; then echo "$(( b / 1024 / 1024 / 1024 ))G"
  else echo "$(( b / 1024 / 1024 ))M"; fi
}

# --- confirm path -----------------------------------------------------------
if [ "$CONFIRM" = "1" ]; then
  require_root
  mkdir -p "$GUARD_DIR"
  date > "$GUARD_CONFIRM"
  log "firewall confirmed from a verified session; the auto-revert guard is cancelled"
  exit 0
fi

require_root
[ "$(uname -s)" = "Linux" ] || die "Linux only"

RAM_KB=$(awk '/MemTotal/{print $2}' /proc/meminfo)
RAM_BYTES=$(( RAM_KB * 1024 ))
DISK_AVAIL=$(df -PB1 / | awk 'NR==2{print $4}')
SWAP_CURRENT=$(swapon --show --noheadings 2>/dev/null | awk '{s+=$3} END{print s+0}')
SWAP_CURRENT_BYTES=$(( SWAP_CURRENT * 1024 ))

# Recommended swap: 1.5–2.5x RAM, bounded by "keep >= 20% of disk free".
SWAP_REC=$(( RAM_BYTES * 2 ))
[ "$SWAP_REC" -gt $(( RAM_BYTES * 5 / 2 )) ] && SWAP_REC=$(( RAM_BYTES * 5 / 2 ))
MAX_BY_DISK=$(( DISK_AVAIL - DISK_AVAIL / 5 ))
[ "$SWAP_REC" -gt "$MAX_BY_DISK" ] && SWAP_REC=$MAX_BY_DISK
if [ -n "$SWAP_OVERRIDE" ]; then SWAP_REC=$(bytes_of "$SWAP_OVERRIDE"); fi
SWAPPINESS_REC=60
[ "$RAM_BYTES" -le $(( 2 * 1024 * 1024 * 1024 )) ] && SWAPPINESS_REC=80

log "plan (apply=$APPLY):"
log "  ram=$(human "$RAM_BYTES")  disk_free=$(human "$DISK_AVAIL")  swap_current=$(human "$SWAP_CURRENT_BYTES")"
log "  1. nftables baseline (input policy drop; allow lo/established/icmp/22; gateway port has no rule)"
log "     + 120s auto-revert guard; confirm with: $0 --confirm-firewall"
log "  2. fail2ban sshd jail (backend=systemd)${SSH_CONNECTION:+ ; ignoreip += ${SSH_CONNECTION%% *}}"
log "  3. unattended-upgrades enabled"
log "  4. swap: current=$(human "$SWAP_CURRENT_BYTES") recommended=$(human "$SWAP_REC") swappiness=$SWAPPINESS_REC"
if [ "$APPLY" != "1" ]; then
  log "dry run — nothing changed. Re-run with --apply to mutate."
  exit 0
fi

# --- 4. swap ---------------------------------------------------------------
if [ "$SWAP_CURRENT_BYTES" -lt "$SWAP_REC" ] && [ "$SWAP_REC" -gt 0 ]; then
  NEED=$(( SWAP_REC - SWAP_CURRENT_BYTES ))
  if [ ! -f /swapfile ]; then
    log "swap: creating /swapfile ($(human "$NEED"))"
    fallocate -l "$NEED" /swapfile
  else
    log "swap: /swapfile exists ($(human "$(stat -c %s /swapfile)")); extending is manual — skipped"
    NEED=0
  fi
  if [ "$NEED" -gt 0 ]; then
    chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile || die "swapon failed"
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
else
  log "swap: adequate ($(human "$SWAP_CURRENT_BYTES"))"
fi
sysctl -qw vm.swappiness="$SWAPPINESS_REC"
grep -q '^vm.swappiness' /etc/sysctl.conf 2>/dev/null || echo "vm.swappiness=$SWAPPINESS_REC" >> /etc/sysctl.conf

# --- 3. unattended upgrades -------------------------------------------------
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq unattended-upgrades > /dev/null
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades
systemctl enable --now apt-daily.timer apt-daily-upgrade.timer > /dev/null 2>&1 || true
log "unattended-upgrades: enabled"

# --- 2. fail2ban -------------------------------------------------------------
apt-get install -y -qq fail2ban python3-systemd > /dev/null
OPERATOR_IP=""
[ -n "${SSH_CONNECTION:-}" ] && OPERATOR_IP="${SSH_CONNECTION%% *}"
IGNOREIP="127.0.0.1/8 ::1"
[ -n "$OPERATOR_IP" ] && IGNOREIP="$IGNOREIP $OPERATOR_IP/32"
cat > /etc/fail2ban/jail.local <<JAIL
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
backend  = systemd
ignoreip = $IGNOREIP

[sshd]
enabled = true
JAIL
systemctl enable --now fail2ban > /dev/null 2>&1 || true
systemctl restart fail2ban
log "fail2ban: active (sshd jail; ignoreip $IGNOREIP)"

# --- 1. nftables with the auto-revert guard ----------------------------------
mkdir -p "$GUARD_DIR"
nft_conf_content > "$NFT_CONF"
rollback_nft > "$GUARD_ROLLBACK"
rm -f "$GUARD_CONFIRM"
nohup sh -c 'sleep 120; if [ ! -f /run/cartethyia-harden/firewall-confirmed ]; then nft -f /run/cartethyia-harden/rollback.nft; echo "[cartethyia-harden] firewall auto-reverted (not confirmed within 120s)" >> /run/cartethyia-harden/guard.log; fi' \
  > /dev/null 2>&1 &
log "guard armed (pid $!): firewall auto-reverts in 120s unless confirmed"
nft -f "$NFT_CONF" && log "nftables baseline applied"
systemctl enable nftables > /dev/null 2>&1 || true

cat <<DONE

[cartethyia-harden] applied. NOW, before the guard expires (120s):
  1. open a SECOND SSH session (do not close this one), and
  2. run:  bash $0 --confirm-firewall
If you cannot get back in, the firewall reverts automatically and nothing
is lost. SSH auth configuration was not touched by this script.
DONE
