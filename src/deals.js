// Deal helpers shared by the server and the backfill script: sector classification, lifecycle
// detection, headline parsing and company-name normalisation. Pure functions, no I/O.

const DEAL_SECTOR_RULES = [
  { id: 'Energy', re: /\b(oil|gas|energy|refiner|pipeline|drilling|shale|lng|utility|power|solar|wind)\b/i },
  { id: 'Technology', re: /\b(software|tech|ai\b|cloud|data centre|data center|semi|chip|cyber|saas|platform|computing|robot)\b/i },
  { id: 'Healthcare', re: /\b(pharma|biotech|drug|health|medical|hospital|diagnostic|therapeutic|clinical|life science|oncology|cancer|genomic|laborator|testing)\b/i },
  { id: 'Financials', re: /\b(bank|insur|fintech|lender|asset manager|broker|payments?|exchange|wealth|trading platform|marketplace|life insurance)\b/i },
  { id: 'Industrials', re: /\b(industrial|manufactur|machin|aerospace|defen[cs]e|chemical|material|mining|steel|cement|logistics|packaging|waste|recycl|equipment)\b/i },
  { id: 'Consumer', re: /\b(retail|consumer|food|beverage|restaurant|apparel|grocery|brand|cosmetic|drinks?)\b/i },
  { id: 'Media', re: /\b(media|entertainment|studio|film|streaming|gaming|music|publish|advertis|sports|hollywood|broadcast|tv)\b/i },
  { id: 'Telecom', re: /\b(telecom|wireless|broadband|fibre|fiber|spectrum|mobile operator)\b/i },
  { id: 'Real estate', re: /\b(reit|real estate|property|warehouse)\b/i },
];
const dealSector = (title) => (DEAL_SECTOR_RULES.find((s) => s.re.test(title)) || { id: 'Other' }).id;
const DEAL_SITES = '(site:reuters.com OR site:bloomberg.com OR site:ft.com OR site:cnbc.com OR site:apnews.com OR site:wsj.com)';
// The four states a deal passes through. Each channel below feeds the same store.
const DEAL_RUMOUR = /\b(in talks|in advanced talks|explores|exploring|weighs|weighing|considers|considering|approaches|approached|mulls|said to|reportedly|is said|potential|may|could|would)\b/i;
const DEAL_CLOSED = /\b(completes?|completed|closes?|closed|wraps? up|finali[sz]es?|merger (?:is )?complete|deal (?:is )?done)\b/i;
const DEAL_ENDED = /\b(terminates?|terminated|scraps?|abandons?|calls? off|called off|walks? away|blocked|halts?|rejects?)\b/i;
const eventStatus = (t) => DEAL_ENDED.test(t) ? 'terminated' : DEAL_CLOSED.test(t) ? 'closed' : DEAL_RUMOUR.test(t) ? 'rumour' : 'announced';
const STATUS_RANK = { rumour: 1, announced: 2, closed: 3, terminated: 3 };
const CHANNELS = [
  { id: 'announce', q: '(acquire OR acquisition OR merger OR takeover OR "to buy") ("billion" OR "million")', needValue: true },
  { id: 'rumour', q: '("in talks" OR exploring OR weighs OR considers) (acquire OR acquisition OR merger OR takeover)', needValue: false },
  { id: 'close', q: '("completes" OR "closes" OR "completion of" OR "wraps up") (acquisition OR merger)', needValue: false },
  { id: 'end', q: '(terminates OR scraps OR abandons OR "calls off") (merger OR acquisition OR takeover)', needValue: false },
];

const NAME_STOP = new Set(['inc', 'corp', 'corporation', 'company', 'group', 'holdings', 'holding', 'partners', 'capital', 'global', 'international', 'technologies', 'technology', 'solutions', 'systems', 'industries', 'the', 'and', 'for', 'from', 'with', 'ltd', 'plc', 'llc', 'limited', 'sa', 'nv', 'ag']);
const nameTokens = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !NAME_STOP.has(w));
const nameKey = (s) => nameTokens(s).sort((a, b) => b.length - a.length)[0] || '';

function parseDealTitle(t) {
  // "$9.7B" and "$9.7bn" are as common as "$9.7 billion".
  const cur = /([$\u20ac\u00a3])\s?([\d.,]+)\s?(billion|million|bn|mn|b|m)\b/i.exec(t);
  let value = null;
  if (cur) { const n = parseFloat(cur[2].replace(/,/g, '')); value = /^b/i.test(cur[3]) ? Math.round(n * 1000) : Math.round(n); }
  const cut = (s) => String(s || '').replace(/\s+/g, ' ').replace(/[\u2019']s$/, '').replace(/[,.;:]+$/, '').replace(/^(?:the)\s+/i, '').trim();
  const stake = /^(.{2,42}?)\s+(?:to|will|agrees? to)\s+(?:buy|acquire|purchase)\s+(?:a\s+)?(?:[\d.]+%\s+)?(?:majority\s+|minority\s+)?stake in\s+(.{2,58}?)(?=\s+(?:for|from|at)\b|,|$)/i.exec(t);
  if (stake) return { acquirer: cut(stake[1]), target: cut(stake[2]), value };
  const pats = [
    /^(.{2,42}?)\s+(?:to|will|is to|agrees? to|nears?|seals?|closes?|wraps? up|completes?)\s+(?:buy|acquire|purchase|take over|merge with|snap up)\s+(.{2,58}?)(?=\s+(?:for|in|from|at|worth|as)\b|,|$)/i,
    /^(.{2,42}?)\s+(?:announces?|unveils?)\s+(?:a\s+)?\$[\d.]+\s?(?:billion|million)\s+(?:deal|takeover)\s+(?:for|to buy)\s+(.{2,58})$/i,
  ];
  for (const re of pats) {
    const m = re.exec(t);
    if (m) {
      let target = cut(m[2]).replace(/^(?:a\s+)?(?:majority\s+|minority\s+)?stake in\s+/i, '');
      return { acquirer: cut(m[1]), target, value };
    }
  }
  // Sell-side headlines: the company doing the buying is at the end, not the start.
  //   "Occidental closes $9.7B sale of OxyChem to Berkshire Hathaway"
  //   "Occidental offloads its chemicals unit to Berkshire for $9.7 billion"
  const sell = [
    /^(.{2,45}?)\s+(?:closes?|completes?|finali[sz]es?)\s+\$[\d.]+\s?(?:billion|million|bn|b|m)\s+(?:sale|divestiture|disposal)\s+of\s+(.{2,50}?)\s+to\s+(.{2,45})$/i,
    /^(.{2,45}?)\s+(?:sells?|offloads?|divests?|disposes? of)\s+(?:its\s+)?(.{2,45}?)\s+in\s+\$[\d.]+\s?(?:billion|million|bn|b|m)\s+deal\s+with\s+([A-Z][\w&'\u2019.\- ]{2,44}?)(?:\s+to\b|$)/i,
    /^(.{2,45}?)\s+(?:sells?|offloads?|divests?|disposes? of)\s+(?:its\s+)?(.{2,50}?)\s+to\s+([A-Z][\w&'\u2019.\- ]{2,44}?)(?:\s+for\b|\s+in\b|,|$)/i,
  ];
  for (const re of sell) {
    const m = re.exec(t);
    if (m) return { acquirer: cut(m[3]), target: cut(m[2]), value };
  }
  const done = /^(.{2,45}?)\s+(?:completes?|closes?|finali[sz]es?)\s+(?:the\s+)?\$[\d.]+\s?(?:billion|million|bn|b|m)\s+(?:acquisition|purchase|takeover)\s+of\s+(.{2,50})$/i.exec(t);
  // "Berkshire Hathaway's $9.7bn Acquisition of OxyChem" and "X completes $9.7B acquisition of Y".
  const own = /^(.{2,45}?)'?s?\s+(?:\$[\d.]+\s?(?:billion|million|bn)\s+)?(?:acquisition|purchase|takeover|buyout)\s+of\s+(.{2,50})$/i.exec(t);
  if (own) return { acquirer: cut(own[1]), target: cut(own[2]), value };
  if (done) return { acquirer: cut(done[1]), target: cut(done[2]), value };

  return { acquirer: null, target: null, value };
}

// "struggling rival WOW Air" and "Part of Cranes Unit" are prose, not companies.
const validName = (n) => !!n && /^[A-Z]/.test(String(n)) && String(n).length <= 55
  && String(n).trim().split(/\s+/).length <= 5
  && !/%|\?|\b(part of|rival|unit|struggling|including|which|that|its|their|stake in|transfers?|ownership|announces?|completes?|closes?|acquires?|sells?)\b/i.test(String(n));

export {
  DEAL_SECTOR_RULES, dealSector, DEAL_SITES, DEAL_RUMOUR, DEAL_CLOSED, DEAL_ENDED, eventStatus,
  STATUS_RANK, CHANNELS, nameTokens, nameKey, parseDealTitle, validName,
};

// Merge one article into the store: attach to the deal it belongs to, or create a new entity.
export function mergeEvent(store, ev) {
  if (ev.date && ev.date < '2020-01-01') return false;        // the store is about current deals
  if (ev.target && !validName(ev.target)) ev.target = null;
  if (ev.acquirer && !validName(ev.acquirer)) ev.acquirer = null;
  const tk = nameKey(ev.target), ak = nameKey(ev.acquirer);
  let hit = null;
  // Match on a shared significant token: "OxyChem" and "OxyChem From Occidental" are the same target
  // even though their longest words differ.
  const evTokens = nameTokens(ev.target).filter((w) => w.length >= 6);
  if (tk) {
    hit = store.deals.find((d) => {
      if (nameKey(d.target) === tk) return true;
      const dt = new Set(nameTokens(d.target));
      return evTokens.some((w) => dt.has(w));
    }) || null;
  }
  // Title matching is only for headlines where we could NOT parse a target. If we have one, matching on
  // a word that merely appears in the headline attached OxyChem stories to an unrelated "Berkshire" row.
  if (!hit && !tk) {
    hit = store.deals.find((d) => {
      const t = nameKey(d.target), a = nameKey(d.acquirer);
      const lower = ev.title.toLowerCase();
      return t && lower.includes(t) && (!a || lower.includes(a));
    }) || null;
  }
  if (!hit && !tk) {
    hit = store.deals.find((d) => {
      const t = nameKey(d.target);
      return t && t.length >= 5 && ev.title.toLowerCase().includes(t);
    }) || null;
  }
  if (!hit && ev.acquirer && ev.value) {
    // Same buyer, same price (within 15%) = the same deal reported by another wire.
    hit = store.deals.find((d) => nameKey(d.acquirer) === ak && d.value
      && Math.abs(d.value - ev.value) / Math.max(d.value, ev.value) < 0.15) || null;
  }
  if (!hit) {
    if (!ev.target || !tk) return false;            // no company name, no entity
    const key = `${tk}|${ak}`;
    if (store.deals.some((d) => d.key === key)) return false;
    store.deals.push({
      key, acquirer: ev.acquirer, target: ev.target, sector: ev.sector,
      value: ev.value, status: ev.status, verified: false,
      date: ev.date, lastSeen: ev.date, closed: ev.status === 'closed' ? ev.date : null,
      rationale: null, advisers: [], url: ev.url, source: ev.source, events: [ev],
    });
    return true;
  }
  if (!hit.events.some((e) => e.url === ev.url)) hit.events.push(ev);
  hit.lastSeen = ev.date > (hit.lastSeen || '') ? ev.date : hit.lastSeen;
  if (STATUS_RANK[ev.status] >= STATUS_RANK[hit.status]) hit.status = ev.status;
  if (ev.status === 'closed') hit.closed = ev.date;
  if (ev.value && !hit.verified) hit.value = ev.value;
  if (ev.acquirer && !hit.acquirer) hit.acquirer = ev.acquirer;
  if (ev.sector && hit.sector === 'Other') hit.sector = ev.sector;
  return true;
}
