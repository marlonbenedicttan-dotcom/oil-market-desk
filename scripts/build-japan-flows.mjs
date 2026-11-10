// Japan extras that J-Quants Light exposes but the main build did not carry:
//   - weekly TSE Prime investor-type flows (foreign / individual / investment trust / ...)
//   - the exchange trading calendar (holidays, half-days, next session)
//   - the dividend ladder from the financial summary (interim, year-end, forecast, next year)
//
// The flow endpoint is section-level, not per issue: show it as market context, never as a
// company-specific "foreigners bought this stock" claim.
//
//   node --env-file-if-exists=.env scripts/build-japan-flows.mjs

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeClient, num } from './jquants.mjs';
import { japanList } from '../src/project.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const JP = join(ROOT, 'data', 'japan.json');
const LIST = join(ROOT, 'data', 'japan-list.json');
const DETAIL = join(ROOT, 'data', 'japan-companies');
const CACHE = join(ROOT, 'data', 'cache', 'jquants');
const DAY = 864e5;
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const yen = (raw) => (raw == null ? null : raw * 1000); // JPX reports these in thousands of yen

const api = makeClient();
const today = iso(Date.now());

// --- weekly flows -------------------------------------------------------------------------------
const from = iso(Date.now() - 730 * DAY);
const raw = await api.investorTypes({ section: 'TSEPrime', from, to: today });
// Revisions add a second row for the same week; the newest PubDate wins.
const byWeek = new Map();
for (const r of raw) {
  if (!r.EnDate) continue;
  const prev = byWeek.get(r.EnDate);
  if (!prev || String(r.PubDate) > String(prev.PubDate)) byWeek.set(r.EnDate, r);
}
const weeks = [...byWeek.values()]
  .sort((a, b) => String(a.EnDate).localeCompare(String(b.EnDate)))
  .map((r) => ({
    d: r.EnDate,
    foreign: yen(num(r.FrgnBal)),
    individual: yen(num(r.IndBal)),
    invTrust: yen(num(r.InvTrBal)),
    brokerage: yen(num(r.BrkBal)),
    proprietary: yen(num(r.PropBal)),
    total: yen(num(r.TotTot)),
  }))
  .filter((w) => w.d && (w.foreign != null || w.individual != null || w.total != null));
const sum = (n, k) => weeks.slice(-n).reduce((a, w) => a + (w[k] || 0), 0);
const pack = (n) => Object.fromEntries(['foreign', 'individual', 'invTrust', 'brokerage', 'proprietary', 'total'].map((k) => [k, sum(n, k)]));
const flow = weeks.length ? {
  section: 'TSEPrime',
  label: 'TSE Prime',
  updated: weeks[weeks.length - 1].d,
  weeks: weeks.slice(-26),
  w4: pack(4),
  w13: pack(13),
  latest: weeks[weeks.length - 1],
} : null;

// --- trading calendar ---------------------------------------------------------------------------
const calEnd = iso(Date.now() + 400 * DAY);
const calRaw = await api.calendar(today, calEnd).catch(() => []);
const kinds = calRaw.map((r) => ({ d: r.Date, kind: num(r.HolDiv) })).filter((x) => x.d);
const openDay = (k) => k === 1 || k === 2;
// The cash session closes at 15:00 JST (06:00 UTC). After that, "next session" is tomorrow.
const afterClose = new Date().getUTCHours() >= 6;
const future = kinds.filter((x) => x.d > today || (!afterClose && x.d === today));
const nextSession = future.find((x) => openDay(x.kind)) || null;
const isWeekend = (d) => [0, 6].includes(new Date(d + 'T00:00:00Z').getUTCDay());
const holidays = future.filter((x) => !openDay(x.kind) && !isWeekend(x.d)).slice(0, 8);
const halfDays = future.filter((x) => x.kind === 2).slice(0, 6);
const todayRow = kinds.find((x) => x.d === today) || null;
const calendar = nextSession || todayRow ? {
  today: todayRow ? { d: todayRow.d, kind: todayRow.kind, open: openDay(todayRow.kind) && !afterClose } : null,
  nextSession: nextSession ? { d: nextSession.d, kind: nextSession.kind, halfDay: nextSession.kind === 2 } : null,
  holidays,
  halfDays,
} : null;

// --- dividend ladder from the cached financial summary ------------------------------------------
function dividendLadder(rows) {
  const fyRows = rows.filter((r) => r.CurPerType === 'FY' && r.CurPerEn);
  fyRows.sort((a, b) => String(a.CurPerEn).localeCompare(String(b.CurPerEn)));
  const last = fyRows[fyRows.length - 1] || null;
  const guided = rows
    .filter((r) => num(r.FNP) != null || num(r.FEPS) != null)
    .sort((a, b) => String(a.DiscDate || '').localeCompare(String(b.DiscDate || '')));
  const g = guided[guided.length - 1] || null;
  const periods = last ? [
    ['Q1', num(last.Div1Q)], ['Interim', num(last.Div2Q)],
    ['Q3', num(last.Div3Q)], ['Year-end', num(last.DivFY)],
  ].filter(([, v]) => v != null) : [];
  const forecastPeriods = g ? [
    ['Q1', num(g.FDiv1Q)], ['Interim', num(g.FDiv2Q)],
    ['Q3', num(g.FDiv3Q)], ['Year-end', num(g.FDivFY)],
  ].filter(([, v]) => v != null) : [];
  const nextYear = num(last?.NxFDivAnn ?? g?.NxFDivAnn);
  const nextPeriods = last ? [
    ['Q1', num(last.NxFDiv1Q)], ['Interim', num(last.NxFDiv2Q)],
    ['Q3', num(last.NxFDiv3Q)], ['Year-end', num(last.NxFDivFY)],
  ].filter(([, v]) => v != null) : [];
  return {
    perShare: last ? num(last.DivAnn) : null,
    total: last ? num(last.DivTotalAnn) : null,
    payoutRatio: last ? num(last.PayoutRatioAnn) : null,
    forecast: g ? num(g.FDivAnn) : null,
    periods: periods.map(([label, value]) => ({ label, value })),
    forecastPeriods: forecastPeriods.map(([label, value]) => ({ label, value })),
    nextYear,
    nextYearPeriods: nextPeriods.map(([label, value]) => ({ label, value })),
  };
}

const jp = readJson(JP);
if (!jp) throw new Error('data/japan.json is missing — run build-japan first');
jp.flow = flow;
jp.calendar = calendar;
let enriched = 0;
for (const c of jp.companies || []) {
  const code = c.code;
  const hit = readJson(join(CACHE, `fins-${code}.json`));
  if (!hit || !Array.isArray(hit.rows) || !hit.rows.length) continue;
  const d = dividendLadder(hit.rows);
  if (d.perShare == null && !d.periods.length && d.nextYear == null) continue;
  const prev = c.dividend || {};
  c.dividend = {
    ...prev,
    ...d,
    yield: prev.yield ?? (c.price && d.perShare ? +((d.perShare / c.price) * 100).toFixed(2) : null),
    forecastYield: prev.forecastYield ?? (c.price && d.forecast ? +((d.forecast / c.price) * 100).toFixed(2) : null),
    nextYearYield: c.price && d.nextYear ? +((d.nextYear / c.price) * 100).toFixed(2) : null,
    growthPct: d.perShare && d.nextYear ? +(((d.nextYear / d.perShare) - 1) * 100).toFixed(1) : null,
  };
  enriched++;
}
jp.updated = new Date().toISOString();
writeFileSync(`${JP}.tmp`, JSON.stringify(jp));
renameSync(`${JP}.tmp`, JP);
const projected = japanList(jp);
writeFileSync(`${LIST}.tmp`, JSON.stringify(projected));
renameSync(`${LIST}.tmp`, LIST);
// Keep the per-company pages in step with the market file (both the ticker and the 5-digit code).
for (const c of jp.companies || []) {
  if (!c.dividend) continue;
  for (const key of new Set([c.code, c.ticker].filter(Boolean))) {
    const f = join(DETAIL, `${key}.json`);
    if (!existsSync(f)) continue;
    const detail = readJson(f);
    if (!detail) continue;
    detail.dividend = { ...(detail.dividend || {}), ...c.dividend };
    writeFileSync(f, JSON.stringify(detail));
  }
}
console.log(`Japan extras · flow ${flow ? flow.updated : 'none'} · next session ${calendar?.nextSession?.d || '—'} · ${enriched} dividend ladders`);
