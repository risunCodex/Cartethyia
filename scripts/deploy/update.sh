#!/usr/bin/env bash
# Cartethyia source-checkout update: fetch, fast-forward when possible, build,
# restart behind a health gate, and roll back to the previous commit if the new
# one never becomes healthy.
#
# The working tree is respected, never overruled:
#   - a dirty tree aborts (commit or stash yourself — the script never stashes)
#   - local commits make the branch diverged: the script STOPS and leaves the
#     resolution to you. Pass --rebase to replay your commits on top of the
#     branch; a conflict stops the rebase mid-way for YOU to resolve, then
#     re-run this script.
#
# Usage:
#   update.sh [--branch <name>] [--rebase] [--no-restart] [--yes] [--skip-build]
set -euo pipefail

BRANCH="${CARTETHYIA_AUTO_UPDATE_BRANCH:-dev}"
REBASE=0
NO_RESTART=0
ASSUME_YES=0
SKIP_BUILD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --branch) [ $# -ge 2 ] || { echo "--branch requires a value" >&2; exit 2; }; BRANCH="$2"; shift ;;
    --rebase) REBASE=1 ;;
    --no-restart) NO_RESTART=1 ;;
    --yes) ASSUME_YES=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

log() { echo "[cartethyia-update] $*"; }
die() { echo "[cartethyia-update] ERROR: $*" >&2; exit 1; }

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "run from inside a Cartethyia checkout"
cd "$ROOT"

# One update at a time — the auto-update timer and a manual run must never
# race each other. flock where it exists (Linux), a mkdir lock elsewhere.
if command -v flock > /dev/null 2>&1; then
  exec 9>"/run/lock/cartethyia-update.lock" 2>/dev/null || exec 9>"${TMPDIR:-/tmp}/cartethyia-update.lock"
  flock -n 9 || die "another update is already running"
else
  LOCKDIR="${TMPDIR:-/tmp}/cartethyia-update.lockdir"
  mkdir "$LOCKDIR" 2>/dev/null || die "another update is already running (lock: $LOCKDIR)"
  trap 'rmdir "$LOCKDIR" 2>/dev/null || true' EXIT
fi

DIRTY=$(git status --porcelain)
if [ -n "$DIRTY" ]; then
  echo "$DIRTY" | head -10
  die "the checkout is dirty. Commit or stash your changes yourself — this script never stashes."
fi

git fetch origin "$BRANCH" 2>&1 | tail -1
read -r AHEAD BEHIND <<<"$(git rev-list --left-right --count "HEAD...origin/$BRANCH")"

if [ "$BEHIND" = "0" ]; then
  if [ "$AHEAD" = "0" ]; then log "already up to date with origin/$BRANCH"; else
    log "local commits ahead ($AHEAD) — nothing to pull"
  fi
  exit 0
fi

OLD=$(git rev-parse HEAD)
log "branch $BRANCH: $AHEAD ahead, $BEHIND behind origin"

if [ "$AHEAD" != "0" ]; then
  log "your branch has $AHEAD local commit(s) that origin/$BRANCH does not have."
  log "The script will not merge or overwrite them. Resolve the divergence yourself:"
  log "  git pull --rebase origin $BRANCH   # replays your commits; conflicts are yours to resolve"
  log "then re-run this script."
  if [ "$REBASE" = "1" ]; then
    log "--rebase given: replaying your commits on top of origin/$BRANCH"
    if ! git pull --rebase origin "$BRANCH"; then
      die "rebase stopped on a conflict. Resolve it (git status shows the files), then 'git rebase --continue' and re-run this script."
    fi
  else
    die "diverged. Pass --rebase to replay your local commits (conflicts stay yours to resolve)."
  fi
else
  git merge --ff-only "origin/$BRANCH"
fi

NEW=$(git rev-parse HEAD)
log "updated: $(git log --oneline -1)"

if [ "$SKIP_BUILD" = "1" ]; then
  log "--skip-build given: skipping install/build"
else
  log "bun install"
  bun install --frozen-lockfile
  if git diff --name-only "$OLD" "$NEW" -- dashboard/src | grep -q .; then
    log "dashboard sources changed — building dashboard"
    bun run dashboard:build
  fi
fi

restart_gateway() {
  if [ "$NO_RESTART" = "1" ]; then log "--no-restart: restart manually"; return 0; fi
  if ! systemctl cat cartethyia > /dev/null 2>&1; then
    log "no cartethyia systemd unit — restart the gateway manually"
    return 0
  fi
  systemctl restart cartethyia
}

health_ok() {
  local port
  port=$(grep -oE '^PORT=[0-9]+' .env 2>/dev/null | cut -d= -f2 || true)
  port=${port:-12800}
  curl -sf --max-time 5 "http://127.0.0.1:${port}/health/ready" > /dev/null 2>&1
}

wait_healthy() {
  local deadline=$(( $(date +%s) + 60 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    health_ok && return 0
    sleep 3
  done
  return 1
}

if [ "$NO_RESTART" = "1" ] || ! systemctl cat cartethyia > /dev/null 2>&1; then
  log "update complete at $NEW (restart not managed by this script)"
  exit 0
fi

restart_gateway
if wait_healthy; then
  log "healthy — update complete at $NEW"
  exit 0
fi

# Health gate failed: put the previous commit back and try once more. The tree
# was verified clean at entry, so this discards only the pulled update.
log "gateway did not become healthy within 60s — rolling back to $OLD"
git reset --hard "$OLD"
if [ "$SKIP_BUILD" = "0" ]; then bun install --frozen-lockfile; fi
restart_gateway
if wait_healthy; then
  log "rolled back to $OLD and healthy. The new commit $NEW never passed the health gate — investigate before re-applying."
else
  die "rolled back to $OLD but the gateway is still unhealthy — check journalctl -u cartethyia -e"
fi
