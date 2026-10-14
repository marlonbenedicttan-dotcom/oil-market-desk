#!/bin/zsh
# Keep the deployed instance warm so a visit doesn't start with a 20-30s cold start.
#
# Why this exists: the Render *free* plan sleeps a web service after ~15 minutes of no traffic, and
# waking it takes 20-30 seconds. Any HTTP request resets that idle timer, so a cheap ping every
# 10 minutes keeps it awake. (The app shows an honest "waking the server" note when it does sleep.)
#
# Usage
#   ./scripts/keepalive.sh                       # one ping
#   ./scripts/keepalive.sh --loop                # ping every 10 min until you stop it
#   UPTIME_URL=https://example.com/health ./scripts/keepalive.sh
#
# Schedule it (cron, every 10 minutes):
#   crontab -e
#   */10 * * * * $HOME/projects/oil-basis/scripts/keepalive.sh >> /tmp/watchtower-keepalive.log 2>&1
#
# Or, with no machine of your own running: point a free uptime monitor at the same URL
# (UptimeRobot / cron-job.org, 10-minute interval) — see the "Keep the service awake" note in HANDOFF.md.
set -u

URL="${UPTIME_URL:-https://oil-market-desk.onrender.com/health}"

ping_once() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 90 "$URL" 2>/dev/null || echo 000)
  printf '%s  http=%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$code" "$URL"
}

if [[ "${1:-}" == "--loop" ]]; then
  echo "keeping $URL warm every 10 minutes — Ctrl-C to stop"
  while true; do ping_once; sleep 600; done
else
  ping_once
fi
