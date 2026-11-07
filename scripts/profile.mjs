// Shared stockanalysis company-profile parser (B3 domestic and the BDR underlying pages).
import { extractBrands } from '../src/brand-extract.js';
import { shortenDescription as shorten } from '../src/desc.js';

export const profileText = (s) => String(s || '')
  .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

export function profileField(html, label) {
  const m = new RegExp(`>${label}</td>\\s*<td[^>]*>([\\s\\S]*?)</td>`).exec(html);
  return m ? profileText(m[1]) || null : null;
}

export function extractProfile(html) {
  const title = (/<title>([^<]*)<\/title>/.exec(html) || [])[1] || '';
  const name = profileText(title)
    .replace(/\s*\([A-Z]{2,6}:[^)]*\).*$/i, '')
    .replace(/\s*\([A-Z.]{1,6}\).*$/i, '')
    .replace(/\s*Company Profile.*$/i, '')
    .replace(/\s*Stock Price.*$/i, '')
    .trim();
  const box = /mb-5">([\s\S]*?)<\/div>/.exec(html);
  const paras = box ? [...box[1].matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => profileText(m[1])) : [];
  const desc = paras.join(' ');
  if (!name || desc.length < 60) return null;
  const first = (desc.match(/^.*?[.。](?=\s|$)/) || [desc])[0];
  const brandInfo = extractBrands(desc);
  return {
    name,
    legal: first.length > 140 ? first.slice(0, 137) + '…' : first,
    desc: shorten(desc),
    sector: profileField(html, 'Sector'),
    industry: profileField(html, 'Industry'),
    brands: brandInfo.brands,
    brandQuote: brandInfo.quote,
  };
}
