# NEXT TASK — COMPANIES: focused company page across all ten markets

**Decision:** implement the focused company page and chart comparison in **production**, for every company in every market. This is the next build after the global board.

Repo: `~/projects/oil-basis` — Marlon's Watchtower
Live: https://oil-market-desk.onrender.com
Stack: zero-dependency Node + vanilla JS. Node is at `~/.local/node/bin`.

---

## 1. What is already live

- **Global Companies board** (commit `e604f934e`):
  - `GLOBAL` is the first market chip.
  - First visit opens the global board; returning readers land on their last market.
  - Flat dot map (`public/world-map.svg`) with 10 markers coloured by 1D move.
  - 10 market tiles, global theme card, global top companies, idea chips.
  - New `/api/home` fields: `markets`, `top`, `ideas`.
  - New `/api/global-themes`: unified themes built from the ten local theme files.
- **HOME calendar fix** (`9db7474bc`): selected-day event list scrolls inside the calendar; heavy macro days no longer stretch the page.
- **Global search** and **mobile full-screen search / deep links** from the other AI are live. Do not rewrite them.

**Not done yet:** the company pages are still the old market-specific layouts. The focused page + chart comparison exists only as a mock.

---

## 2. The task

Apply the focused company page design to all ten market renderers:

| Market | Renderer |
|---|---|
| US | `renderCompanyPageBody` in `public/app.js` |
| Japan | `renderJapanPageBody` |
| Korea | `renderKoreaPage` |
| Taiwan | `renderTaiwanPage` |
| Hong Kong | `renderHongKongPage` |
| Australia | `renderAustraliaPage` |
| India | `renderIndiaPage` |
| Indonesia | `renderIndonesiaPage` |
| Brazil | `renderBrazilPage` |
| South Africa | `renderSouthAfricaPage` |

Design reference: **`public/company-mockup.html`** (Apple, comparison mode). It is a static concept, not production code.
Market landing reference: `public/companies-landing-mockup.html`.
Global board reference: `public/global-markets-mockup.html`.

### Required outcome

Opening any company, from any market, must:

1. **Hide the market chrome above the company** — no market index chart, region row, view tabs, screener filters, or `co-mctx` market-context panel above the company header.
2. Start at a **sticky back bar**: `← COMPANIES`, market/index breadcrumb, optional market selector, watch/compare actions.
3. Show a **company header**: name, ticker, market badge, sector/industry, description, brands.
4. Show **eight key numbers**, not 20+ tiles:
   - market cap · P/E · P/B · ROE · revenue · net income · free cash flow · dividend yield
   - Each figure keeps its basis/source tooltip and local currency.
5. Put the **price chart immediately next** with range tabs and a **comparison control**.
6. Use a **tab strip**: `OVERVIEW · FINANCIALS · VALUATION · PEERS · FILINGS`.
7. Keep the full ratio set behind a **“More stats”** expander.
8. Keep data/source notes in a collapsed **“Data & sources”** block.
9. Work responsively: company starts at the top on mobile, 2-column key tiles, chart below, comparison is one overlay.

---

## 3. The mock to follow

`public/company-mockup.html` contains the intended layout:

- Back bar: `← COMPANIES` / `United States / S&P 1500 / AAPL` / `MARKET United States — S&P 1500 ▾`.
- Header: monogram, name, ticker, sector, description, brands, `WATCH`, `COMPARE`, `OPEN MARKET`.
- Price line + verification badge.
- 8 key numbers.
- `PRICE · COMPARE` chart:
  - `PRICE | COMPARE` toggle.
  - `vs S&P 500 +9.8% ×` chip and `+ COMPARE` button.
  - Lines rebased to 100 at the start of the range.
  - Legend with both returns and relative `+17.1pp`.
- Tabs: Overview / Financials / Valuation / Peers / Filings.
- Overview: “The Read”, Growth & margins with 5-year revenue/net-income, Valuation vs its own history, Next & filings.
- Peers table.
- More stats + Cash & returns cards.
- Data & sources.

Use the real data, not invented numbers. The mock uses Apple data only as a visual reference.

---

## 4. Current company-page problems to fix

- Company page is still rendered **inside** the market/screener screen, so the market chart and filters sit above it. On mobile the company name can start ~600px down.
- Stat grids are 20+ tiles; not scannable.
- Chart comparison is not in production; only the mock.
- Layouts differ between markets; the goal is one shared visual grammar with market-specific currency and source labels.
- The market selector is a long horizontal pill row; the global board now provides a `GLOBAL` chip, but company pages should have a compact back/market context.

---

## 5. Code map

### Front end

`public/index.html`
- Companies pane: `#pane-deals`, `#p-deals`.
- Global search: `#co-global`, `#co-global-input`, `#co-global-panel`.
- Market chips: `#co-region` — now includes `GLOBAL` plus the ten markets.
- Views: `#co-views` (MARKET / SCREENER / THEMES), hidden when `coRegion === 'global'`.
- Tools: `.co-tools`, `#co-search`, `#co-chips`, hidden on company detail.
- Market context strip: `#co-mctx` (the chart that currently appears above company pages).
- Company body: `#co-body`.
- Long US note: `#co-note`.

`public/app.js`
- `coRegion` initialised around line 3440. It now supports `'global'`.
- `renderCompanies()` around line 8799: `if (coRegion === 'global') return renderGlobalBoard(token);` then market renderers.
- Global board: `renderGlobalBoard`, `renderGlobalTheme`, `GMAP`, `GMARKET_COLORS`.
- Company renderers listed above.
- `syncCoTools()` controls the filter bar; currently hides it for company detail.
- `paintCoViews()` clears the view bar for `global`.
- `seriesFor(ref, range)` resolves price series across markets.
- `coLong(ref)` returns the long price series (used by compare/returns).
- `fillPeers()` renders peers in other markets.
- `statementFigures` / `compactMoney` / per-market money formatters.

`public/style.css`
- Existing company classes: `.co-head`, `.co-price`, `.co-stats`, `.co-stat`, `.co-chartwrap`, `.co-tabs`? (check), `.jp-q`, `.gtable`.
- Global board CSS at the end: `.gmap-*`, `.gboard-*`, `.gtheme-*`, `.gtop`, `.gtable`.

`server.js`
- Detail endpoints:
  - US `/api/company/:cik`
  - Japan `/api/japan/company/:code`
  - Korea `/api/korea/company/:code`
  - Taiwan `/api/taiwan/company/:code`
  - Hong Kong `/api/hongkong/company/:code`
  - Australia `/api/australia/company/:code`
  - India `/api/india/company/:code`
  - Indonesia `/api/indonesia/company/:code`
  - Brazil `/api/brazil/company/:code`
  - South Africa `/api/southafrica/company/:code`
- New global endpoints:
  - `/api/home` — markets, ideas, top companies.
  - `/api/global-themes` — unified themes.
- Chart endpoints per market; `coLong`/`seriesFor` handle refs like `us:AAPL`, `jp:7203`, `kr:005930`, `tw:2330`, `hk:0700`, etc.

### Data

- `data/companies.json` — US (S&P 1500; `spTier` 500/400/600).
- `data/japan.json` + `data/japan-list.json`.
- `data/korea.json` + `data/korea-list.json`.
- `data/taiwan.json` + `data/taiwan-list.json` + `data/taiwan-series/`.
- `data/hongkong.json` + `data/hongkong-list.json` + `data/hongkong-series/`.
- `data/australia.json` + `data/australia-list.json` + `data/australia-series/`.
- `data/india.json`, `data/indonesia.json`, `data/brazil.json`, `data/southafrica.json` plus their list artifacts.
- Theme files: `data/{market}-themes.json` where market filename is `us`, `japan`, `korea`, `taiwan`, `hongkong`, `australia`, `india`, `indonesia`, `brazil`, `southafrica`.

### Field map for the 8 key numbers

- US: `marketCap`, `pe`, `pb`, `roe`, `revenueTTM ?? revenue`, `netIncomeTTM ?? netIncome`, `fcfTTM ?? fcf`, `dividendYield`.
- Japan: `marketCap`, `pe`, `pb`, `roe`, `sales`, `np`, `fcf`, `dividend.yield`.
- Korea: `marketCap`, `pe`, `pb`, `roe`, TTM flows from `quarters` (or `reports`), `fcf`, `dividendYield`/`payoutYield`.
- Taiwan/HK/AU/IN/ID/BR/ZA: `marketCap`, `pe`, `pb`, `roe`, `reports.ttm` revenue/net income/cash flow, `fcf`, `dividendYield`.
- Always use the market's own currency and the existing formatters; never mix currencies.

---

## 6. Implementation plan

### Phase 1 — focused shell (all markets)

- Add a focused state when a company is open: e.g. `#p-deals.dataset.focused = '1'` or `#co-body.classList.add('co-focused')`.
- Hide above the company:
  - `#co-mctx`
  - `.co-tools` (screener filters)
  - the market chart/index header from the market view (ensure `renderCompanies` doesn’t paint it before the company)
  - optionally the region/view rows; keep the global search and a back bar.
- Add a shared back bar and a sticky company header. Reuse the existing `ma-crumb`/`co-head` grammar.
- Make sure `renderCompanies()` routes to the company renderer **before** any market view for every market.
- Test: open a company from the screener on all ten markets; the page must start at the company header.

### Phase 2 — eight key numbers + more stats

- Add a shared `co-key-grid` with 8 tiles.
- Map the fields per market (section 5).
- Keep the existing full stats behind a “More stats” `<details>` or expander.
- On mobile show 2 columns; on desktop 4 or 8.
- Tooltips: basis (TTM/FY), source and as-of date.

### Phase 3 — chart comparison

- Add a `Compare` control to each company chart header:
  - `PRICE | COMPARE` toggle.
  - `vs <index/company>` chip with ×; `+ COMPARE`.
  - Range tabs already exist per market.
- Picker:
  - Use global search or the existing compare box; selecting a company/index sets the overlay.
  - Presets: market index, sector/peer, another company.
- Series:
  - Use `seriesFor(ref, range)` / `coLong(ref)`.
  - Align dates, rebase both to 100 at the first common date.
  - Overlay one line (or max two) with a legend and relative pp.
  - Handle missing series honestly with a message.
- Chart ranges: 1M/3M/6M/YTD/1Y/5Y; mobile one overlay.
- Verification: AAPL vs S&P 500 in the mock; production must work for any company in any market.

### Phase 4 — tabs and sections

- Add a shared tab strip: OVERVIEW / FINANCIALS / VALUATION / PEERS / FILINGS.
- Overview: “The Read”, growth/margins, valuation history, next/filings.
- Financials: existing five-year + quarterly tables.
- Valuation: P/E range, P/B, EV/EBITDA, FCF yield; use existing `bands`/history.
- Peers: existing `fillPeers` + a compact table.
- Filings: latest filing, period, verification, link.
- Hide the old long notes in a collapsible “Data & sources”.

### Phase 5 — mobile

- Company page starts at top.
- Back bar and market selector stack.
- 8 key numbers in 2 columns.
- Chart below.
- One comparison overlay.
- Tables hide non-essential columns (e.g. market cap) at 390px.
- No horizontal overflow; test `document.documentElement.scrollWidth === clientWidth`.

---

## 7. Rules and constraints

- **Zero runtime dependencies.** No new packages.
- **Never fake a number.** Missing = `—`/`n/a` with reason.
- Keep every figure's source and as-of date.
- Do not change the data pipelines or daily workflows.
- Do not touch:
  - global search / mobile full-screen search / deep links,
  - HOME calendar or global board,
  - macro/commodities views,
  - US/JP/KR/TW/HK/AU/IN/ID/BR/ZA data builders.
- Another AI may be pushing to `main`. Before editing:
  - `git status --short`
  - `git pull --rebase --autostash origin main`
  - Resolve conflicts by keeping both features; do not drop the other AI's work.
- The working tree currently has **uncommitted daily data files** and untracked mockups. Do not stage/commit those data files.
- Keep tests green: `npm test` (currently 523 pass).
- Asset versions are automatic; no manual `?v=` bump.
- Deploy = `git push origin main`; Render rebuilds in ~2–3 min; verify `/health` version and the live page.

---

## 8. Verification checklist

- [ ] Open a company from each of the ten markets; no market chart/filters above the header.
- [ ] Eight key numbers present and correct in local currency.
- [ ] Price chart + compare works; AAPL vs S&P 500 and at least one cross-market pair.
- [ ] Tabs/overview/financials/valuation/peers/filings render.
- [ ] More stats and data notes collapse.
- [ ] Mobile 390px: company at top, 2-column key stats, chart, one overlay, no horizontal overflow.
- [ ] `npm test` pass.
- [ ] Live deploy verified at `/health` and by opening a company page on the live URL.

Useful commands:

```bash
export PATH="$HOME/.local/node/bin:$PATH"
cd ~/projects/oil-basis
npm start          # http://localhost:4173
npm test
curl -s localhost:4173/health
```

Headless Chrome is available for screenshots at 1440 and 390 widths.

---

## 9. Known pitfalls

- `coRegion` now includes `'global'`; guard any code that assumes one of the ten markets.
- `shareClass` is not always boolean: Brazil uses `'PN'`, `'ON'`, `'UNIT'`. Only skip `shareClass === true`; skip `bdr` separately.
- Japan theme codes can be 5-digit (`70110`) while the list ticker is 4-digit (`7010`); index both `ticker` and `code` when looking up.
- The US company page uses `renderCompanyPageBody`; the other nine markets have separate renderers. Do not copy the US renderer blindly; map fields.
- `#co-mctx` is the market-context chart currently shown above company pages; hide it in focused mode.
- `co-tools` is the screener filter bar; hide it in focused mode.
- `co-note` is the long US-only note; hide it on non-US and global boards.
- The global search overlay may be open when switching; close it or let the user dismiss it.
- Foreign-currency statements use `compactMoney` / `reportCurrency`; the listing currency is not always the statement currency.
- Preserve the existing mobile full-screen search CSS; it was added by another AI.

---

## 10. Paste-ready prompt for a new agent

```text
Work in ~/projects/oil-basis (Marlon's Watchtower, zero-dependency Node + vanilla JS).
Read NEXT-TASK-COMPANIES.md first, then AGENT-BRIEF.md and HANDOFF.md.

Task: implement the focused company page and chart comparison in production for all ten markets
(US, Japan, Korea, Taiwan, Hong Kong, Australia, India, Indonesia, Brazil, South Africa).
Use public/company-mockup.html as the visual reference.

Start with Phase 1: when a company is open, hide the market chart, region/view rows, screener
filters and #co-mctx above the company; add a shared sticky back bar and company header; make
sure renderCompanies routes to the company renderer before any market view. Then add the eight
key numbers, the chart compare overlay (rebased to 100, one overlay, relative pp), and the
tabs/more-stats layout. Roll the same shell across all ten market renderers.

Rules: never fake numbers; missing = — with a reason. Do not touch global search, mobile
search/deep links, HOME, the global board, or data pipelines. Another AI may push; pull --rebase
--autostash before editing. Do not commit the uncommitted daily data files or the untracked mocks.
Run npm test; deploy with git push origin main; verify /health and the live company pages.
```
