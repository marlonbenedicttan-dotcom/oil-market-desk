# NEXT TASK — fix the mobile top bar + the moving ticker, and tighten news context

**Read `HANDOFF.md` first** (architecture, registries, deploy, conventions), then this.
Repo `~/projects/oil-basis` (a git repo; **push to `main` auto-deploys to Render**, ~2–3 min).
Node: `export PATH="$HOME/.local/node/bin:$PATH"`. Zero-dependency Node ≥22. Tests: `npm test`
(**63** — must stay green). Bump `?v=` in `public/index.html` after **any** `app.js`/`style.css`
change. **Never fake a number.** Current tip: `666f3f3` (`style.css?v=28`, `app.js?v=67`).

Two independent problems. Do them one at a time (code + test + deploy each).

---

## Problem 1 — the mobile top bar is messy and the moving ticker doesn't move

### Symptom
On a real iPhone (portrait, normal hold) the **top area looks bad / not fitted**, and the
**auto-scrolling ticker appears frozen** ("it broke"). It worked before the recent mobile CSS
passes, so a regression is likely. **The user has confirmed their iPhone "Reduce Motion" is OFF.**

### ⭐ KEY CLUE (2026-10-13): it works in LANDSCAPE but not in PORTRAIT
The user reports *"everything works perfectly in landscape but not when not landscape."*
iPhone portrait ≈ **390–430 CSS px** → the `@media (max-width: 640px)` block **applies**;
landscape ≈ **844 px** → it **does NOT**, so landscape uses the **base/desktop CSS** and is fine.
**Therefore the bug is inside the `@media (max-width: 640px)` block (`public/style.css:464–499`)
— that is the regression surface. Start there; do not hunt elsewhere.**
Also note the `@media (max-width: 760px)` / `(max-width: 700px)` blocks apply in portrait only
(landscape 844 > 760), so they are also suspect.

**Bisect on-device (fast):** temporarily delete/disable the whole `≤640` block, reload portrait,
confirm the top is sane and the ticker moves; then re-add its rules **one at a time** until it
breaks — the offending rule will be obvious (the ticker has only `animation-duration: 45s` at
`:475` + `.tk` sizing at `:497` in there; the header rules are `:465–476`).
**Pragmatic fix:** since the **desktop/landscape layout works**, make portrait **closer to it** —
i.e. remove the 2-line header wrap and keep a **single-row header** (the working desktop one) with
smaller/icon-only buttons, rather than inventing a separate mobile header. Fewer portrait-only
overrides = fewer bugs.

### Where it lives
- Ticker markup: `public/index.html:51` — `<div id="ticker" class="ticker"></div>`
- Ticker CSS: `public/style.css:44–48` (base), plus `:475` (`animation-duration: 45s` in the
  ≤640 block) and `:497` (`.tk` sizing).
- Ticker JS: `public/app.js:610` `renderTicker(m)` — builds `.ticker-track` with **two identical
  copies** (`track.innerHTML = \`<div class="ticker-track">\${one}\${one}</div>\``) and the CSS
  animates `translateX(0 → -50%)` for a seamless loop.
- Header markup: `public/index.html:40–49` (`.topbar` → `.brand` + `.meta`).
- Header/footer CSS: `public/style.css:28–41` (base), the ≤640 block at `:464`, and the
  `.desk-only` / `.mobile-only` helper at `:453`.

### Current CSS (verbatim, so you can see the state)
```css
.ticker { overflow: hidden; …; white-space: nowrap; }
.ticker-track { display: inline-flex; gap: 0; animation: ticker-scroll 120s linear infinite; will-change: transform; }
@media (hover: hover) { .ticker:hover .ticker-track { animation-play-state: paused; } }   /* :46 */
@keyframes ticker-scroll { from { transform: translateX(0); } to { transform: translateX(-50%); } }
@media (prefers-reduced-motion: reduce) { .ticker-track { animation: none; } .ticker { overflow-x: auto; … } }  /* :48 */
```
≤640 block: `.ticker-track { animation-duration: 45s; }` (`:475`).

### Hypotheses, most-likely first
> **Because landscape (base CSS) works and portrait (≤640 block) doesn't, suspect a rule IN the
> `≤640` block FIRST — not the base ticker.** The base `.ticker-track` animation demonstrably works
> in landscape, so the portrait regression must come from a portrait-only override.
1. **A portrait-only rule in the `≤640` block** (`style.css:464–499`) that breaks the ticker/layout.
   Bisect it (see above).
2. **iOS Safari can still match `@media (hover: hover)`** (a long-standing quirk on iPhones too),
   so scoping the pause to `(hover: hover)` did **not** stop `:hover` from **latching after a
   touch**. Verify on the device: `window.matchMedia('(hover: hover)').matches` vs `'(hover: none)'`.
   **Safest fix: delete the hover-pause entirely (`style.css:46`).**
3. **`prefers-reduced-motion`** — user says it's off, but confirm on-device:
   `window.matchMedia('(prefers-reduced-motion: reduce)').matches`.
4. **`will-change: transform` + inline-flex** compositing on iOS — test by removing `will-change`.
5. **`animation-duration` override** (`:475`) — confirm the animation is applied
   (`getComputedStyle(track).animationName === 'ticker-scroll'`).

### Recommended fix (make it deterministic, don't fight iOS)
Rather than relying on a CSS marquee that iOS quirks can freeze, **drive the ticker in JS**:
- Keep TWO copies in the track (already done).
- Animate with `requestAnimationFrame` (or the Web Animations API `track.animate(...)`) so you have
  full control; **pause on `pointerdown` only while held**, and **never** use `:hover`.
- Or, on mobile, **make the ticker a native horizontal scroll strip** (`overflow-x:auto`,
  `-webkit-overflow-scrolling:touch`, hide the scrollbar) and drop the marquee — deterministic,
  swipeable, no animation quirks. (User earlier said they *liked* the motion; if you keep motion,
  use rAF/WAAPI, not CSS `:hover`.)

### Top-bar tidy (the user chose this already)
Move **CSV** and **DAILY BRIEF** out of the header on phones → they now live in a footer row
(`.exports.mobile-only` before `<footer id="notes">`, added at `index.html:~299`). Header should be
**one tidy line**: `♜ MARLON'S WATCHTOWER · clock · ↻ · ?`. **Audit the whole top on-device**: the
header, ticker, the **.tabs** row (`.tabs { overflow-x:auto }`), and the first panel — the user says
the top is "really messed up", so look at the actual render, not just the CSS. Consider a **compact
mobile header** (smaller wordmark, icon buttons ~32px) and consistent spacing.

### How to actually see it (I could not — no browser here)
Connect the iPhone by USB → **Safari → Develop → [iPhone] → the page**, then inspect: `Elements`
(computed styles), `Animations` panel (is `ticker-scroll` running? paused?), and the Console for the
`matchMedia` checks above. That will settle the ticker cause in one minute.

---

## Problem 2 — news context is still too loose (e.g. NBA news on Silver)

### Symptom
A chart/news item about **basketball ("Adam Silver", NBA)** was attached to **silver**. Any headline
containing `Silver` (a surname) matches. More generally: **keyword-only matching with no topic
guard.**

### Where it lives (all in `server.js`)
- `NEWS_MUST` (per segment/region/country) — `:1292`
- `mustScoreFor(specs, title)` (relevance + where the term appears) — `:1326`
- `titleMatches(id, title)` — `:1340`
- `NEWS_FOCUS` (per **instrument**) — `:1342`
- `newsDir(title)` (headline's own up/down words) — `:1356` (`DIR_UP`/`DIR_DOWN` at `:1354–55`)
- `getMoveWho(id, reqs, focusId)` — the picker that scores candidates — `:1706`
- Used by: `getMoveWho`, `getFundamentals`, `getNews`, `getAttribution`.
- Client side: `chartMoveMarkers` (`app.js:925`), `attachMarkers` (`:952`), `applyNewsDataset` (`:973`).

### Why it fails
`mustScoreFor` only checks **keyword presence + position**. `silver` matches `/\bsilver\b/i` in
"Adam **Silver**". There is **no market-context requirement** and **no block-list** for
sports/entertainment/proper nouns.

### Proposed fixes (ranked; do (a)+(b))
- **(a) Require a market context.** A candidate must ALSO match a small market-context regex
  (price / ounce / troy / tonne / futures / spot / contract / demand / supply / mine / smelter /
  stocks / rally|sells off …). If a commodity term matches but no market context does, **reject**.
  This kills "Adam Silver" instantly. Apply it in `getMoveWho` (and `getFundamentals`/`getNews`).
- **(b) A topic block-list.** Reject headlines matching obvious non-market contexts —
  `\b(NBA|NFL|MLB|NHL|Olympics?|playoffs?|quarterback|coach|actor|actress|movie|film|singer|album|
  celebrity|box office|game \d|signed with|traded to)\b` — **unless** they also pass (a) strongly.
- **(c) Proper-noun heuristic.** If the commodity word is immediately preceded by a capitalised
  first name + space (e.g. `Adam Silver`), treat as a surname → drop. Fragile — only a tiebreaker.
- **(d) Source/domain** — tier-1 filter already limits to Reuters/Bloomberg/FT/AP/CNBC, but wire
  services also cover sport; (a)/(b) are the real fix.
- Move these guards into **`src/lib.js`** as **pure functions** (e.g. `newsContext(title, term)`)
  so they get **unit tests** (the repo convention: pure logic lives in `lib.js`, tested).

### Verify
- `curl 'localhost:PORT/api/movewho?id=precious&focus=silver&dates=<a date with an NBA Silver story>'`
  → must **not** return the basketball story.
- Sanity: a real metals story (*"Silver jumps on safe-haven demand"*) must still match.
- Add a `lib.test.js` unit test for the new pure guard (reject the NBA title, accept the metals one).
- Re-check the other segments' queries for the same class of bug (e.g. `corn` → "corn maze",
  `coffee` → a person; `platinum` → a record/award name).

---

## Gotchas (learned this session — don't repeat)
- **Deploy:** `git push origin main` → Render (~2–3 min). The **server restarts**, clearing the
  in-process `cached()` map — so a "stale" server response after a deploy is expected for the first
  call or two.
- **Caches:** server `cached(key, ttl, fn)` (`server.js:158`) now **de-dupes in-flight** requests;
  client `jget(url, ttl)` (`app.js:~79`) memoises per session. `movewho:` results are cached **6 h
  per (id,date)** — when testing a fix, use **fresh dates** or restart the server, or you'll see the
  old (wrong) match.
- **`?v=` bump** required on `style.css` AND `app.js` after changes (the SW is network-first but
  browsers cache hard; the user has had to hard-refresh).
- **Tests run serially** and hit live feeds — can be flaky; re-run before concluding.
- **iOS specifics:** `:hover`/`:active` latch; **`@media (hover: hover)` may still match on iPhone**;
  `prefers-reduced-motion` is a real, respected setting. Test on-device via Safari Web Inspector.
- The **warm loop** (`server.js` `warmCaches`, ~:2548) precomputes every segment's READ every 8 min —
  it de-dupes with user requests, so don't worry about collisions.
- `.github/workflows/*` is **untracked** on purpose (no `workflow` scope) — don't add it.

## Definition of done
- Ticker **moves on an iPhone** and no longer freezes after a touch (or is a clean swipe strip).
- The mobile top (header + ticker + tabs + first panel) looks **intentional**, not cramped.
- `Adam Silver`/NBA news can **never** attach to silver (and the same guard applies to
  fundamentals/headlines/attribution); a pure-function unit test proves it.
- `npm test` green (add the new tests), `?v=` bumped, deployed, verified on-device.
