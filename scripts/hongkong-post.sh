#!/bin/sh
# After the coverage loop: give it two more passes (so a throttled pass is not mistaken for "finished"),
# attach profiles, complete the largest companies' optional pages, rebuild, audit, and write the status.
set -u
export PATH="$HOME/.local/node/bin:$PATH"
cd "$(dirname "$0")/.." || exit 1
LOG=data/.hk-finish.log
say() { echo "=== $(date '+%H:%M:%S') $*" >> "$LOG"; }
covered() { node -e "const h=require('./data/hongkong.json');console.log(h.companies.length)" 2>/dev/null || echo 0; }

while pgrep -f "hongkong-finish.sh" >/dev/null 2>&1; do sleep 60; done
say "coverage loop exited (covered=$(covered)) — extra insurance passes"

for pass in 1 2; do
  before=$(covered)
  say "insurance pass $pass (covered=$before)"
  node scripts/build-hongkong.mjs --skip-prices --fast --fin-workers=1 --page-gap=900 >> "$LOG" 2>&1
  after=$(covered)
  say "insurance pass $pass done — covered=$after (+$((after-before)))"
  [ "$after" -le "$before" ] && sleep 300
done

say "profiles (sectors, names, descriptions)"
node scripts/fetch-hongkong-profiles.mjs --workers=4 --gap=900 >> "$LOG" 2>&1

say "polish: cash-flow + quarterly pages for the largest companies"
if [ "$(date +%H%M)" -lt 0700 ]; then
  node scripts/hongkong-polish.mjs --top=250 >> "$LOG" 2>&1
else
  say "past 07:00 — skipping polish so the dataset is final rather than half-polished"
fi

say "final rebuild + audit"
node scripts/build-hongkong.mjs --cached-only --skip-prices >> "$LOG" 2>&1
node scripts/audit-hongkong.mjs > data/.hk-audit.txt 2>&1
{
  echo "Hong Kong build status — $(date)"
  node -e "
    const h=require('./data/hongkong.json'); const a=h.audit||{};
    console.log('main-board company lines:', a.commonStocks);
    console.log('built:', h.companies.length, '| with P/E:', h.companies.filter(c=>c.pe!=null).length, '| described:', h.companies.filter(c=>c.description).length);
    console.log('cross-listed statements:', h.companies.filter(c=>c.statementsFrom).length, '| no statements on any listing:', a.withoutStatements, '| throttled:', a.throttled||0);
    console.log('market cap: HK\$'+(h.market.totalCap/1e12).toFixed(2)+'T | median P/E', h.market.medianPe, '| median P/B', h.market.medianPb, '| median yield', h.market.medianYield+'%');
  "
  echo; echo '--- audit'; tail -22 data/.hk-audit.txt
} > data/.hk-status.txt 2>&1
say "POST DONE (covered=$(covered))"
