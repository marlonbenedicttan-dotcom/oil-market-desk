# POLISH-ROADMAP — make the desk feel *professional and complete*

Read `HANDOFF.md` first (architecture, conventions, deploy). This is the **quality** backlog:
trust, accessibility, wording, information architecture, and completeness. It is separate from
`INVESTOR-ROADMAP.md`, which is the **feature** backlog. Do items **one at a time**: code + tests +
deploy, verify live.

---

## How this was audited
- Rendered the **live** site at 1440×900 (HOME · COMMODITIES · MACRO), 390×844 portrait, and the
  boot screen, via headless Chrome.
- Read `public/index.html` `<head>`, `manifest.json`, `sw.js`; grepped every user-facing string and
  all `aria-*` / `role=` usages.

## Status
**Items 1–6 DONE (2026-10-13)** — see `HANDOFF.md` → Latest. Remaining: 7 (IA/heading/legend),
8 (chart a11y / CDN fallback / security headers), 9 (minify + version surface), then the
`INVESTOR-ROADMAP.md` features.

## What is already strong (don't "fix" these)
Honest data with source + as-of badges; signed price score + physical tightness; adaptive plain-English
reads; the news-on-chart markers with the new context guard; boot splash; per-panel empty states;
`prefers-reduced-motion` respected; focus-visible outlines; glossary; the two-score model.

---

## A. Trust & credibility  (highest leverage — this is what reads as "professional")

**A1. Timestamps are inconsistent and confusing.** *(evidence: header shows `13:54:11` then
`prices 1:53:58 PM` side-by-side — two clocks, two formats)*
`app.js:1163` sets `#updated` to `'prices ' + toLocaleTimeString()` (12-h AM/PM, machine locale),
while the clock is 24-h, the brief says `13/10/2026, 13:51:18` (en-GB), and country cards say
`2026-10-13` (ISO). Pick **one** convention: `Updated 13:53 (local) · data delayed` or a relative
`Updated 2 min ago`, and add a timezone note once. Remove the duplicate header clock/timestamp.

**A2. No freshness indicator on mobile.** `#updated` is `display:none` under 640px, so on a phone the
user cannot see how stale the data is (the brief's `as of` is lower down). Add a small live/stale dot
in the header (e.g. green ● / amber ●) with an accessible label.

**A3. Social preview image + icons are missing/unusable.** `og:image` points at `/icon.svg` — most
platforms will not render an SVG preview. Add a real **1200×630 PNG** OG image, an **apple-touch-icon**
(180×180 PNG), a PNG favicon (32/16), and wire them in `<head>`. iOS "Add to Home Screen" currently
gets no proper icon.

**A4. Add a "Data & Methodology" section (or page).** One place that states: every source (Yahoo
delayed, FRED, EIA, BIS, World Bank/IMF snapshot, CFTC, Google News), the **delay/lag** of each, what
the two scores mean, how basis is computed, and the disclaimer. This is the single biggest
"credibility" uplift — the README has the table; the *site* should too.

**A5. Disclaimer placement.** It appears once in the THE READ header (`NOT INVESTMENT ADVICE`) and in
the footer. Consider a persistent, quieter footer line + the Methodology page; avoid shouting it in
one panel header only.

---

## B. Accessibility  (target WCAG 2.1 AA)

**B1. Icon buttons have no accessible name.** `#refresh` (`↻`) and `#help-open` (`?`) are bare
buttons; `?` has only `title`. Add `aria-label="Refresh data"` / `aria-label="Help & guide"`.
Same for `#help-btn`, `#alert-settings` (they have text — OK), and any icon-only controls.

**B2. The tabs aren't a real tablist.** `index.html:58–60` are plain `<button class="tab">`. Add
`role="tablist"`, each `role="tab"` + `aria-selected` + `aria-controls`, and the panes `role="tabpanel"`.
Add Arrow-Left/Right keyboard support.

**B3. The ticker violates WCAG 2.2.2.** It auto-starts and moves indefinitely with no pause/stop
mechanism (only press-and-hold). Add a visible **pause/play** control (small ⏸ in the header or at the
ticker's edge) and pause automatically when the tab is hidden (`visibilitychange`) and on
`prefers-reduced-motion` (already handled).

**B4. The onboarding overlay isn't a dialog.** Add `role="dialog"`, `aria-modal="true"`,
`aria-labelledby`, focus the button on open, **trap focus**, and close on `Escape`.

**B5. The error banner should announce.** `#error` (`.errbar`) has no `role="alert"` — screen readers
miss transient failures.

**B6. Charts have no text alternative.** `<canvas>` elements carry no label. At minimum give each a
`role="img"` + `aria-label` summarising the series; ideally a small "view as table" affordance.

**B7. Emoji in headings are read aloud** ("pushpin WATCHLIST"). Wrap decorative emoji in
`<span aria-hidden="true">` or drop them for a cleaner look (see D4).

**B8. Contrast on 10px labels** (`--dim #7c8a99` on near-black) is ≈5.4:1 — AA-passing for body text
but the 8–10px labels are hard to read. Nudge `--dim` lighter for micro-labels.

---

## C. Wording & microcopy

**C1. Kill the ambiguous `prices 1:53:58 PM`** (see A1).
**C2. Unify the ellipsis.** Code mixes `…` (27×) and `...` (31×). Pick `…`.
**C3. Unify + harden state copy.** Many variants: `loading…`, `loading headlines…`,
`loading the curve…`, `brief unavailable right now`, `headlines unavailable`,
`image unavailable right now`, `unavailable right now`. Standardise three states per panel:
*loading* / *empty (why)* / *error (retrying)*. Make errors actionable: *"Couldn't reach the wire —
retrying in 10 min"* not just "unavailable".
**C4. Explain the scores in-place.** `60/100`, `+75/100`, `83/100` appear with different meanings
(range percentile, signed stretch, tightness). Add a one-line legend/tooltip so a newcomer isn't lost.
**C5. Jargon pass.** `reading the full verdict…`, `cross-asset knock-on`, `still thinking…` — soften to
plain English; the app prides itself on being plain.
**C6. `<title>` + meta description** could carry the value prop:
`Marlon's Watchtower — commodities & macro, in plain English`.

---

## D. UI/UX & information architecture

**D1. HOME is a very long scroll** (brief → watchlist → alerts → headlines → 9-segment board). Add a
**sticky in-page sub-nav** (jump chips) so the top isn't the only navigation.
**D2. "Answer first" is missing.** The app makes you explore; investors want regime + opportunity on
load. This is `INVESTOR-ROADMAP.md` #2 (cross-asset regime board) and #3 (screener) — do them next.
**D3. No quick-jump / search.** A `/`-to-search instrument palette (jump to any benchmark's chart)
would make a 31-instrument app feel navigable.
**D4. Emoji + ALL-CAPS headers are inconsistent.** Some panels have emoji (🎯 📰 ⚖️), some don't
(PRICE HISTORY, IN REFINING MARGINS). Either all or none; and pick a heading style. A restrained
style (no emoji, one typographic system) reads more "Bloomberg" and less "hobby".
**D5. Loading skeletons.** Replace text-only loading with a shimmer block sized to the content to
avoid layout jumps.
**D6. Keyboard shortcuts.** `1/2/3` tabs, `r` refresh, `/` search, `p` pause ticker, `?` help —
document them in the guide.

---

## E. Mobile (beyond the recent passes)

**E1. Tables** still scroll horizontally (`.antable { min-width:420px }`); verify each table is
readable and doesn't clip. Consider card-stacking the widest ones.
**E2. Freshness** (A2) and the **ticker pause** (B3) matter most on mobile.
**E3. Tap-target audit** across `select`, chips, chart-event links, `.tab`, star toggles.
**E4. Chart heights** (200–240px) are OK; long macro charts could use a "fit width" default.

---

## F. Technical completeness / SEO / PWA

**F1. No 404 page.** Unknown paths return plain-text `not found` (`server.js:2525`). Serve a styled
404 with a link home.
**F2. No `<noscript>`.** With JS off the page is blank + a stuck boot beacon. Add a fallback message.
**F3. No `robots.txt` / `sitemap.xml` / canonical** — add (even for a private-ish desk, it's expected).
**F4. Icons/OG PNGs** (see A3).
**F5. `manifest.json`** — add `purpose:"maskable"` icon, `screenshots`, and fix the **description**
(it still says "Real barrels vs futures" — oil-only, predates the rebrand).
**F6. Duplicate `<meta name="theme-color">`** (`#05070a` and `#ff9e00`) — keep one (the amber).
**F7. CDN resilience.** Chart.js + Leaflet load from CDNs; if a CDN is blocked/slow the charts fail
silently. Add a visible "charts unavailable" fallback + `onerror`.
**F8. Minify** `app.js` (144 KB) and `style.css` (36 KB) via a tiny build step (or serve pre-gzipped)
— the free tier benefits.
**F9. Security headers** on all responses: `Content-Security-Policy` (start report-only),
`X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options`.
**F10. Build/version surface.** `/health` returns uptime; add a `version` (git SHA) and show it in the
footer — helps diagnose "am I on the new build?".

---

## G. Feature completeness
See `INVESTOR-ROADMAP.md` (positioning #1, regime board #2, screener #3, custom alerts #4, economic
calendar #5). Those turn "a dashboard" into "a desk".

---

## Suggested order (quick wins → bigger)

| # | Item | Effort | Why now |
|---|------|--------|---------|
| 1 | A1 + A2 timestamps & freshness (one format, mobile visible) | S | Most-seen, currently confusing |
| 2 | B1–B4 a11y basics (labels, tablist, ticker pause, dialog) | S–M | Correctness + compliance |
| 3 | A3 + F4 icons & OG image (PNG) | S | Fixes link previews + home-screen icon |
| 4 | F1 + F2 404 + noscript | S | Removes dead-end / blank states |
| 5 | C1–C3 wording + unified states | S–M | Reads as care, not a prototype |
| 6 | A4 Data & Methodology section | M | Biggest credibility jump |
| 7 | D1 + D4 + C4 IA/heading/legend tidy-up | M | Makes the density navigable |
| 8 | B6 + F7 + F9 chart a11y, CDN fallback, security headers | M | Robustness |
| 9 | F8 + F10 build minify + version surface | M | Performance + diagnosability |
| 10 | then `INVESTOR-ROADMAP.md` #1–#5 | L | The actual "desk" features |

## Definition of done (each item)
- Behind a `?v=` bump if front-end; `npm test` green; deployed; **verified on the live URL**.
- No new jargon; every new number/label is explained or tooltipped.
- Nothing faked; every timestamp is timezone-explicit.
