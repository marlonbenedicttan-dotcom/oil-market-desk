#!/bin/sh
# Start the desk and expose it at a free public URL (Cloudflare quick tunnel).
# Usage:  sh scripts/share.sh
set -e
cd "$(dirname "$0")/.."

echo "Starting the desk…"
node --env-file-if-exists=.env server.js &
APP=$!
trap 'kill $APP 2>/dev/null' EXIT

sleep 2
echo ""
echo "Opening a free public URL (look for the https://…trycloudflare.com line below):"
echo ""
cloudflared tunnel --url http://localhost:4173
