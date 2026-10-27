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

// Headline grammar leaks into party names: "DoorDash Is Said to Near Instacart" gives an acquirer of
// "DoorDash Is Said to Near". Strip the reporting verbs and newsroom tags before storing.
const PARTY_TAIL = /\s+(?:is said to(?: be)?|said to(?: be)?|is nearing|nears?|is near|near|in talks(?: to)?|plans? to|weighs?|to buy|to acquire|to take over|to merge with)\b[\s\S]*$/i;
const PARTY_HEAD = /^(?:(?:[\w&.'-]+-backed|privately held|state-owned|publicly traded|u\.s\.|us|uk|british|french|german|japanese|chinese|canadian|australian)\s+)+/i;
const PARTY_TAG = /[,\s]+(?:ft|reuters|bloomberg|wsj|the wall street journal|sources?|people familiar|reports?)\b[\s\S]*$/i;
function cleanParty(n) {
  if (!n) return null;
  let s = String(n).replace(/\s+/g, ' ').trim();
  s = s.replace(PARTY_TAIL, '').replace(PARTY_TAG, '').replace(PARTY_HEAD, '').replace(/[,.;:]+$/, '').trim();
  return s || null;
}

// "struggling rival WOW Air" and "Part of Cranes Unit" are prose, not companies.
const validName = (n) => !!n && /^[A-Z]/.test(String(n)) && String(n).length <= 55
  && String(n).trim().split(/\s+/).length <= 5
  && !/%|\?|\b(part of|rival|unit|struggling|including|which|that|its|their|stake in|transfers?|ownership|announces?|completes?|closes?|acquires?|sells?)\b/i.test(String(n));

export {
  SIC_SECTOR, isGenericTarget,
  DEAL_SECTOR_RULES, dealSector, DEAL_SITES, DEAL_RUMOUR, DEAL_CLOSED, DEAL_ENDED, eventStatus,
  STATUS_RANK, CHANNELS, nameTokens, nameKey, parseDealTitle, validName, cleanParty,
};

// Merge one article into the store: attach to the deal it belongs to, or create a new entity.
export function mergeEvent(store, ev) {
  if (ev.date && ev.date < '2020-01-01') return false;        // the store is about current deals
  ev.acquirer = cleanParty(ev.acquirer);
  ev.target = cleanParty(ev.target);
  if (ev.target && !validName(ev.target)) ev.target = null;
  if (ev.acquirer && !validName(ev.acquirer)) ev.acquirer = null;
  // Validation at INGESTION, not only in the cleanup script: objects and headline fragments must never
  // become companies in the first place.
  if (ev.target && (isGenericTarget(ev.target) || /company announcement|press release|\bannouncement\b/i.test(ev.target))) ev.target = null;
  if (ev.acquirer && /\$|\boffers?\b|\bweighs?\b|\bin talks\b/i.test(ev.acquirer)) ev.acquirer = null;
  if (ev.target && ev.acquirer && nameKey(ev.target) === nameKey(ev.acquirer)) return false;
  if (!ev.acquirer && !ev.value) return false;                 // nothing to show but a target name
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
  // A re-mention is not an event. Only a status that moves forward (announced → closed/terminated)
  // belongs on the timeline; an anniversary piece about a 2023 deal must not look like news.
  if (!hit.events.some((e) => e.url === ev.url)) {
    if ((STATUS_RANK[ev.status] || 0) > (STATUS_RANK[hit.status] || 0)) hit.events.push(ev);
    else hit.mentions = (hit.mentions || 0) + 1;
  }
  hit.lastSeen = ev.date > (hit.lastSeen || '') ? ev.date : hit.lastSeen;
  if (STATUS_RANK[ev.status] >= STATUS_RANK[hit.status]) hit.status = ev.status;
  if (ev.status === 'closed') hit.closed = ev.date;
  // Value provenance has a priority: a filing beats a computed number beats a Wikipedia table.
  const VRANK = { verified: 4, filing: 3, computed: 2, wikipedia: 1, wire: 0 };
  if (ev.value && (!hit.value || (VRANK[ev.valueSource] || 0) > (VRANK[hit.valueSource] || 0))) {
    hit.value = ev.value;
    hit.valueSource = ev.valueSource || 'wire';
    hit.valueBasis = ev.valueBasis || null;
  }
  if (ev.acquirer && !hit.acquirer) hit.acquirer = ev.acquirer;
  if (ev.sector && hit.sector === 'Other') hit.sector = ev.sector;
  return true;
}

// SEC SIC code -> sector. The filings' own classification is far better than guessing from headline words,
// which is why "Other" was 31 deals before this existed.
const SIC_SECTOR = (sic) => {
  const n = Number(sic) || 0;
  if (n >= 100 && n < 1000) return 'Agriculture';
  if (n >= 1300 && n < 1400) return 'Energy';          // crude petroleum & natural gas
  if (n >= 1000 && n < 1500) return 'Mining';
  if (n >= 1500 && n < 1800) return 'Construction';
  if (n >= 2000 && n < 2200) return 'Consumer';
  if (n >= 2200 && n < 2400) return 'Consumer';
  if (n >= 2400 && n < 2800) return 'Materials';
  if (n >= 2830 && n < 2840) return 'Healthcare';
  if (n >= 2800 && n < 2900) return 'Materials';
  if (n >= 2900 && n < 3200) return 'Energy';
  if (n >= 3200 && n < 3400) return 'Materials';
  if (n >= 3400 && n < 3600) return 'Industrials';
  if (n >= 3570 && n < 3580) return 'Technology';      // computers
  if (n >= 3600 && n < 3700) return 'Technology';
  if (n >= 3700 && n < 3800) return 'Industrials';
  if (n >= 3800 && n < 4000) return 'Healthcare';
  if (n >= 4830 && n < 4900) return 'Media';          // broadcast, cable, publishing
  if (n >= 4810 && n < 4830) return 'Telecom';        // telephone communications
  if (n >= 4000 && n < 4900) return 'Industrials';
  if (n >= 4900 && n < 5000) return 'Energy';
  if (n >= 5000 && n < 5200) return 'Consumer';
  if (n >= 5200 && n < 6000) return 'Consumer';
  if (n >= 6000 && n < 6200) return 'Financials';
  if (n >= 6200 && n < 6300) return 'Financials';
  if (n >= 6300 && n < 6500) return 'Financials';
  if (n >= 6500 && n < 6600) return 'Real estate';
  if (n >= 6700 && n < 6800) return 'Financials';
  if (n >= 7000 && n < 7300) return 'Consumer';
  if (n >= 7370 && n < 7380) return 'Technology';      // prepackaged software, data processing
  if (n >= 7300 && n < 8000) return 'Industrials';
  if (n >= 8000 && n < 8100) return 'Healthcare';
  if (n >= 8100 && n < 9000) return 'Industrials';
  return 'Other';
};
// A target that is an object, not a company: leases, share counts, "membership interests".
const isGenericTarget = (t) => /^(?:new |the |certain )?(?:lease|leases|shares|stock|interests?|notes?|units?|assets|business|operations?|rights?|licen[cs]es?|permits?|properties)\b/i.test(String(t || ''))
  || /\b(?:fixed shares|membership interests|equity interests|common stock|previous lease|and previous)\b/i.test(String(t || ''))
  // "Ares fund buys competitor" names no company. Exact match only, so "London Stock Exchange Group"
  // and "Target Corp" are not caught.
  || /^(?:a |an |the )?(?:competitor|rival|peer|company|firm|startup|buyer|seller|target|entity|business|group|partner|operator|provider|maker|manufacturer)$/i.test(String(t || '').trim());

// A deal announced 18+ months ago with no termination event is, in practice, closed. We say so — but
// flag it as inferred so the UI can be honest that no closing filing was found.
export function inferStatus(d, now = Date.now()) {
  const st = d.status || 'announced';
  if (st !== 'announced') return { status: st, inferred: false };
  const t = Date.parse(d.date || '');
  if (!t) return { status: st, inferred: false };
  const months = (now - t) / (30 * 864e5);
  return months >= 18 ? { status: 'closed', inferred: true } : { status: st, inferred: false };
}
export const dealType = (t) => {
  const s = String(t || '');
  if (/tender offer/i.test(s)) return 'tender';
  if (/\b(stake|minority|majority interest)\b/i.test(s)) return 'stake';
  if (/\bassets?\b/i.test(s)) return 'asset';
  if (/\bmerger\b/i.test(s)) return 'merger';
  return 'acquisition';
};
