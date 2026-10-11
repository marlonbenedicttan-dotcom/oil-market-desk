#!/bin/zsh
# Refresh the IMF WEO snapshot and push it, so the deployed app picks up new data.
# Run weekly by ~/Library/LaunchAgents/com.marlon.watchtower.macro.plist (or manually).
# The IMF API is blocked from the deploy host, so we fetch here and commit the result.
set -e
export PATH="$HOME/.local/node/bin:$PATH"
cd "$HOME/projects/oil-basis"
node scripts/fetch-macro.mjs
git add data/macro.json
if git diff --staged --quiet; then echo "no change to data/macro.json"; exit 0; fi
git commit -m "chore: refresh macro snapshot (IMF WEO)"
git push
