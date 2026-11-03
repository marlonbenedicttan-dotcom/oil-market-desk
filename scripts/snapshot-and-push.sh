#!/bin/zsh
# Manual escape hatch — refresh the upstream snapshots now and push them.
#   node scripts/fetch-usda.mjs   -> data/usda.json
#   node scripts/fetch-macro.mjs  -> data/macro.json
#
# The scheduled refresh is .github/workflows/macro-snapshot.yml (Mondays 04:17 UTC). This script used to
# run as a Monday LaunchAgent (~/Library/LaunchAgents/com.marlon.watchtower.macro.plist, retired Nov 2026)
# and it was a bad scheduler: it duplicated the CI macro fetch for a timestamp-only diff, its bare
# `git push` lost the race against the daily jobs, and nothing ever reported that it had failed. It is
# kept for "I want these numbers right now", where a human is watching.
set -u
export PATH="$HOME/.local/node/bin:$PATH"
cd "$HOME/projects/oil-basis"

log() { print -u2 "[$(date -u +%FT%TZ)] $*"; }

# One run at a time. POSIX-mkdir lock: flock is not on macOS.
LOCK="${TMPDIR:-/tmp}/watchtower-snapshot.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  log "another snapshot run is in progress ($LOCK) — remove it if that is wrong"
  exit 1
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# USDA first and independently: it is the snapshot with no other path if this is the only run, and an
# IMF outage must not take it down with it. (The LaunchAgent's `set -e` did exactly that.)
failed=""
if node scripts/fetch-usda.mjs; then :; else failed="$failed usda"; fi
if node scripts/fetch-macro.mjs; then :; else failed="$failed macro"; fi

git add data/macro.json data/usda.json
if git diff --staged --quiet; then
  log "no change to the snapshots"
  [ -z "$failed" ] || { log "but the fetch failed:$failed"; exit 1; }
  exit 0
fi

git commit -m "chore: refresh macro + USDA snapshots"
if ! git push; then
  log "push rejected — the remote moved. This repo usually has uncommitted work, so rebase by hand:"
  log "    git pull --rebase origin main && git push"
  exit 1
fi
log "pushed"
[ -z "$failed" ] || { log "push succeeded, but the fetch failed:$failed"; exit 1; }
