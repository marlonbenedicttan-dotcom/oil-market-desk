// Pull consumer brands out of a company description.
//
// The profile text supplied by S&P Global / stockanalysis.com often names the product brands in a
// predictable phrase: "under the ANTA, FILA and DESCENTE brands", "under the X brand name", or "the
// brand portfolio includes X, Y and Z". Those sentences are a much better source than the company
// name alone, and they are already fetched for every Hong Kong profile.
//
// The parser is deliberately conservative: it only reads phrases that explicitly introduce brands,
// rejects generic placeholders ("various", "third-party", "own"), and caps the list. A missing brand
// is better than a guessed one.

const GENERIC = new Set([
  'a', 'all', 'an', 'another', 'both', 'brand', 'branded', 'brands', 'different', 'eight', 'five',
  'four', 'its', 'its own', 'leading', 'major', 'many', 'multiple', 'new', 'nine', 'one', 'other',
  'our', 'own', 'premium', 'private label', 'several', 'single', 'six', 'such', 'ten', 'the', 'their',
  'these', 'third party', 'third-party', 'those', 'three', 'two', 'various',
]);

const NOISE = /\b(?:arrangements?|based|brand|brands|brand name|brand names|branded|company|companies|consumer|co|corp|founded|has|had|headquartered|inc|inspired|is|are|licensed|limited|ltd|management|plants?|products?|proprietary|providing|self-developed|self-owned|sells?|services?|shops?|stores?|outlets?|including|includes?|such as|as well as|consisting of|comprising|portfolio|various|was|were|other|own|third[- ]party|private[- ]label)\b/i;

const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'co', 'ltd', 'inc', 'corp', 'jr', 'sr', 'h', 'c', 'j', 't', 's', 'g', 'p', 'e', 'm', 'b', 'r', 'w', 'a', 'u', 'v', 'x', 'y', 'z']);

const MAX_BRANDS = 10;

const textOf = (s) => String(s || '')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&#39;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/&nbsp;/g, ' ')
  .replace(/\\u003C[^>]*>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// The description box on the vendor page. The old page wraps it in `mb-5">…</div>`; the cached HTML
// is kept exactly as received, so this works on both live and cached copies.
export function profileDescription(html) {
  const box = /mb-5">([\s\S]*?)<\/div>/.exec(String(html || ''));
  if (!box) return '';
  const paras = [...box[1].matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => textOf(m[1]));
  return paras.join(' ');
}

const cleanBrand = (s) => {
  let v = String(s || '')
    .replace(/^[\s"'“”‘’(]+|[\s"'“”‘’)]+$/g, '')
    .replace(/^(?:of|its|their|and|&)\s+/i, '')
    .replace(/^the\s+(?=[A-Z])/, '')
    .replace(/\s+(?:manufactured|made|produced|sold|marketed|offered|distributed)\b.*$/i, '')
    .replace(/\s+(?:and|or|of|for|with|from|under|to|by|in|on|at)$/i, '')
    .replace(/[.;:,]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // "Lexar. Shenzhen …" is a sentence break; "Mr. Juicy" and "H. Moser" are names.
  v = v.replace(/([A-Za-z]{2,})\.\s+([A-Z][a-z].*)$/, (m, head) => {
    const last = head.split(/\s+/).pop().toLowerCase();
    return ABBREVIATIONS.has(last) ? m : head;
  });
  return v;
};

function splitList(raw) {
  let s = String(raw || '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s—–-]+|[\s—–-]+$/g, '')
    .trim();
  // A description often continues after the brand list with "The company …" or "It was founded …".
  // Cut that tail before splitting; brand names such as "Mr. Juicy" do not match these clause starters.
  const tail = /\.\s+(?:the company|it|this|these|its|was|is|has|had|founded|headquartered|based|operates|offers|provides|sells|manufactures|distributes)\b/i.exec(s);
  if (tail) s = s.slice(0, tail.index);
  if (!s) return [];
  let parts = s.split(/\s*,\s*/);
  // A list written without a comma ("Watsons Water and Mr. Juicy") is a single part. For the last
  // comma-separated part, "and" is the final separator; inside an earlier part it may be part of a
  // real name ("Shangri-La Hotels and Resorts"), so leave those alone.
  if (parts.length === 1) parts = s.split(/\s+and\s+/i);
  else {
    const last = parts[parts.length - 1];
    const m = /^(.*?)\s+and\s+(.+)$/i.exec(last);
    if (m) parts = [...parts.slice(0, -1), m[1], m[2]];
  }
  return parts
    .flatMap((p) => p.split(/\s+as well as\s+/i))
    .map((p) => cleanBrand(p).replace(/^(?:and|&)\s+/i, ''))
    .filter(Boolean);
}

function valid(b) {
  if (!b || b.length < 2 || b.length > 40) return false;
  if (GENERIC.has(b.toLowerCase())) return false;
  if (NOISE.test(b)) return false;
  if (!/^[\p{L}\p{N}]/u.test(b)) return false;
  if (/^\d+(?:[.,]\d+)?$/.test(b)) return false;
  if (b.split(/\s+/).length > 7) return false;
  return true;
}

const patterns = [
  // "under three brands – Niccolo, Marco Polo and Maqo"
  { re: /\bunder\s+(?:the\s+|its\s+|their\s+)?(?:two|three|four|five|six|seven|eight|nine|ten|\d+)?\s*brands?\s*[—–-]\s*([^.;]{1,300})/gi, list: true },
  // "under the brand name of Yunnan Baiyao"
  { re: /\bunder\s+(?:the\s+|its\s+|their\s+)?brand\s+name\s+(?:of\s+)?([^.;]{1,100})/gi, list: false },
  // "under the brand names SHEIN, MOTF and ROMWE" / "under the brand names of TONGSHIFU, …"
  { re: /\bunder\s+(?:the\s+|its\s+|their\s+)?brand\s+names?\s+(?:of\s+)?([A-Z0-9][\s\S]{1,300}?)(?=\s*(?:\.\s+(?:The|It|In|This|Its|These)\b|;|$))/gi, list: true },
  // "under its proprietary brands, including Royal Medic, … and Health Proof"
  { re: /\b(?:under|with)\s+(?:the\s+|its\s+|their\s+)?(?:proprietary|self-developed|owned|licensed)?\s*brands?,?\s+(?:including|include)\s+([\s\S]{1,300}?)(?=\s*(?:,?\s+as well as\b|\.\s+(?:The|It|In|This|Its|These)\b|;|$))/gi, list: true },
  // "the brand portfolio includes agnès b., JILLSTUART and Fila brands"
  { re: /\bbrand\s+portfolio\s+(?:includes?|comprises?|consists?\s+of)\s+([\s\S]{1,500}?)\s+brands?\b/gi, list: true },
  // "brands include X, Y and Z"
  { re: /\bbrands?\s+(?:include|includes|such\s+as)\s+([^.;]{1,300})/gi, list: true },
  // "under the FILA, FILA KIDS and ANTA KIDS brands" / "under the X brand name"
  { re: /\bunder\s+(?:the\s+|its\s+|their\s+)?([^;]{1,1000}?)\s+brands?\b/gi, list: true },
];

export function extractBrands(input) {
  let working = textOf(input);
  if (!working) return { brands: [], quote: null };
  const found = [];
  const quotes = [];
  for (const { re, list } of patterns) {
    re.lastIndex = 0;
    const consumed = [];
    let m;
    while ((m = re.exec(working)) !== null) {
      const candidates = list ? splitList(m[1]) : [cleanBrand(m[1])];
      const validOnes = candidates.filter(valid);
      if (validOnes.length) {
        for (const b of validOnes) if (!found.some((x) => x.toLowerCase() === b.toLowerCase())) found.push(b);
        quotes.push(m[0].trim());
        consumed.push([m.index, m.index + m[0].length]);
      }
      if (found.length >= MAX_BRANDS * 2) break;
    }
    // Do not let a later, broader pattern read the same sentence and pick up its tail.
    if (consumed.length) {
      const chars = working.split('');
      for (const [a, b] of consumed) for (let i = a; i < b; i++) chars[i] = ' ';
      working = chars.join('');
    }
  }
  return { brands: found.slice(0, MAX_BRANDS), quote: quotes.join(' ') || null };
}

// Curated first, then the profile extraction, then any parent-brand expansion. Deduping is
// case-insensitive so "Descente" from the curated file wins over "DESCENTE" from a description.
export function mergeBrands(lists, groups = {}) {
  const out = [];
  const seen = new Set();
  const add = (b) => {
    const v = String(b || '').replace(/\s+/g, ' ').trim();
    if (!v) return;
    const k = v.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    out.push(v);
  };
  for (const list of lists) {
    for (const b of list || []) {
      const children = groups[String(b).toUpperCase()];
      if (children && children.length) {
        for (const child of children) add(child);
      } else {
        add(b);
      }
    }
  }
  return out;
}
