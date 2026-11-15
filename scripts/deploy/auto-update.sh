#!/usr/bin/env bash
# Opt-in auto-update watcher. One tick per invocation (a systemd timer calls
# it); behavior is fully env-controlled and OFF unless the operator turns it
# on.
#
#   CARTETHYIA_AUTO_UPDATE          off | notify | apply    (default: off)
#   CARTETHYIA_AUTO_UPDATE_BRANCH   branch to track         (default: dev)
#   CARTETHYIA_AUTO_UPDATE_INTERVAL timer interval          (default: 1h)
#
#   auto-update.sh               one tick: check, then notify or apply
#   auto-update.sh --install-timer
#                                write and enable the systemd units (the
#                                timer stays disabled while mode is "off")
#
# Safety: "apply" never forces anything — the underlying update.sh only
# fast-forwards a clean tree and refuses diverged branches, so an operator's
# local commits always stop the automation, never get clobbered.
set -uo pipefail

MODE="${CARTETHYIA_AUTO_UPDATE:-off}"
BRANCH="${CARTETHYIA_AUTO_UPDATE_BRANCH:-dev}"
INTERVAL="${CARTETHYIA_AUTO_UPDATE_INTERVAL:-1h}"

log() { echo "[cartethyia-auto-update] $*"; }

install_timer() {
  local root
  root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "run from inside a Cartethyia checkout" >&2; exit 2; }
  local script_dir="$root/scripts/deploy"

  cat > /etc/systemd/system/cartethyia-auto-update.service <<UNIT
[Unit]
Description=Cartethyia auto-update tick (mode: $MODE, branch: $BRANCH)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$root
Environment=CARTETHYIA_AUTO_UPDATE=$MODE
Environment=CARTETHYIA_AUTO_UPDATE_BRANCH=$BRANCH
ExecStart=$script_dir/auto-update.sh
UNIT

  cat > /etc/systemd/system/cartethyia-auto-update.timer <<UNIT
[Unit]
Description=Periodic Cartethyia auto-update check

[Timer]
OnBootSec=10min
OnUnitActiveSec=$INTERVAL
Unit=cartethyia-auto-update.service

[Install]
WantedBy=timers.target
UNIT

  systemctl daemon-reload
  if [ "$MODE" = "off" ]; then
    systemctl disable --now cartethyia-auto-update.timer 2>/dev/null || true
    log "mode is off — timer disabled"
  else
    systemctl enable --now cartethyia-auto-update.timer
    log "timer enabled (mode=$MODE branch=$BRANCH interval=$INTERVAL)"
  fi
}

case "${1:-}" in
  --install-timer) install_timer; exit 0 ;;
  "") ;;
  *) echo "unknown argument: $1" >&2; exit 2 ;;
esac

[ "$MODE" = "off" ] && exit 0

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { log "not a checkout"; exit 0; }
cd "$ROOT"

git fetch origin "$BRANCH" 2>/dev/null || { log "fetch failed; skipping this tick"; exit 0; }

BEHIND=$(git rev-list --count "HEAD..origin/$BRANCH")
[ "$BEHIND" -eq 0 ] && exit 0

NEW=$(git log --oneline -1 "origin/$BRANCH")
log "origin/$BRANCH is $BEHIND commit(s) ahead: $NEW"

if [ "$MODE" = "notify" ]; then
  log "notify mode — run scripts/deploy/update.sh manually to apply"
  exit 0
fi

if [ "$MODE" = "apply" ]; then
  # Never force from the watcher: a dirty or diverged tree stops update.sh by
  # design, and this tick simply reports it.
  log "apply mode — running scripts/deploy/update.sh --yes --branch $BRANCH"
  exec bash "$ROOT/scripts/deploy/update.sh" --yes --branch "$BRANCH"
fi

log "unknown CARTETHYIA_AUTO_UPDATE mode '$MODE' (use off|notify|apply)"
exit 2
