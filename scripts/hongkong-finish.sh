#!/bin/sh
# Drive Hong Kong to full main-board coverage overnight, then rebuild, audit and write a status file.
#
# Each pass fetches companies still missing statements (busiest first, cross-listed companies from their
# other listing), rebuilds from cache and measures coverage. A pass that adds nothing is retried once
# after a cooldown, because a throttled pass is not the same as "there is nothing left".
set -u
export PATH="$HOME/.local/node/bin:$PATH"
cd "$(dirname "$0")/.." || exit 1
LOG=data/.hk-finish.log
STATUS=data/.hk-status.txt
say() { echo "=== $(date '+%H:%M:%S') $*" >> "$LOG"; }
covered() { node -e "const h=require('./data/hongkong.json');console.log(h.companies.length)" 2>/dev/null || echo 0; }

say "start (covered=$(covered))"
stale=0
for pass in 1 2 3 4 5 6 7 8 9 10 11 12; do
  before=$(covered)
  say "pass $pass — fetching (covered=$before)"
  node scripts/build-hongkong.mjs --skip-prices --fast --fin-workers=1 --page-gap=900 >> "$LOG" 2>&1
  after=$(covered)
  say "pass $pass done — covered=$after (+$((after-before)))"
  if [ "$after" -le "$before" ]; then
    stale=$((stale+1))
    say "no gain (stale=$stale/3) — cooling down 10 min"
    [ "$stale" -ge 3 ] && break
    sleep 600
  else
    stale=0
  fi
done

say "profiles for new companies"
node scripts/fetch-hongkong-profiles.mjs --workers=4 --gap=900 >> "$LOG" 2>&1

say "final rebuild + audit"
node scripts/build-hongkong.mjs --cached-only --skip-prices --fast >> "$LOG" 2>&1
node scripts/audit-hongkong.mjs > data/.hk-audit.txt 2>&1
node scripts/audit-hongkong.mjs --sample=15 >> data/.hk-audit.txt 2>&1

{
  echo "Hong Kong build status — $(date)"
  echo "companies: $(covered)"
  node -e "
    const h=require('./data/hongkong.json');
    const a=h.audit||{};
    console.log('main-board lines:', a.commonStocks, '| built:', h.companies.length, '| no statements on any listing:', a.withoutStatements, '| throttled:', a.throttled||0);
    console.log('with P/E:', h.companies.filter(c=>c.pe!=null).length, '| with description:', h.companies.filter(c=>c.description).length);
    console.log('cross-listed statements:', h.companies.filter(c=>c.statementsFrom).length);
    console.log('market cap: HK\$'+(h.market.totalCap/1e12).toFixed(2)+'T | median P/E', h.market.medianPe, '| median yield', h.market.medianYield+'%');
  "
  echo
  tail -20 data/.hk-audit.txt
} > "$STATUS" 2>&1
say "DONE (covered=$(covered))"
