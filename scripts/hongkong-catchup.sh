#!/bin/sh
# Finish the Hong Kong build unattended (resumable, validates every page before caching).
set -u
export PATH="$HOME/.local/node/bin:$PATH"
cd "$(dirname "$0")/.." || exit 1
LOG=data/.hk-catchup.log
say() { echo "=== $(date '+%H:%M:%S') $*" >> "$LOG"; }

say "statements pass 1 — busiest first, one page at a time (2 workers, 0.7s gap)"
node scripts/build-hongkong.mjs --skip-prices --fin-workers=2 --page-gap=700 >> "$LOG" 2>&1

say "statements pass 2 — fill throttled companies (1 worker)"
node scripts/build-hongkong.mjs --skip-prices --fin-workers=1 --page-gap=700 >> "$LOG" 2>&1

say "profiles pass 2 — companies added by the backfill"
node scripts/fetch-hongkong-profiles.mjs --workers=4 --gap=1200 >> "$LOG" 2>&1

say "final rebuild + audit"
node scripts/build-hongkong.mjs --cached-only --skip-prices >> "$LOG" 2>&1
node scripts/audit-hongkong.mjs >> "$LOG" 2>&1
say "DONE"
