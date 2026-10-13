# AGENT-BRIEF — paste this to brief the next AI agent

Copy the block below into a fresh session and fill in the task at the end. It is enough for an agent
to be productive in one read (the detail lives in `HANDOFF.md`).

---

Repo: `~/projects/oil-basis` — **"Marlon's Watchtower"**, a zero-dependency Node + vanilla-JS
commodity & macro dashboard (3 tabs: HOME / COMMODITIES / MACRO). It auto-deploys from GitHub to
Render on push to `main`.

**Read first:** `HANDOFF.md` (architecture, registries, API, deploy, conventions, gotchas), then the
doc that matches your task:
- **Features / new capability** → `INVESTOR-ROADMAP.md` (Tier 1–3; Tier 1 and most of Tier 2 are done)
- **Quality / UX / a11y / wording** → `POLISH-ROADMAP.md` (all done) + the "Latest" log in `HANDOFF.md`
- **Loading / mobile** → the loading + mobile notes at the end of `HANDOFF.md`

**Environment**
- Node lives at `~/.local/node/bin` — run `export PATH="$HOME/.local/node/bin:$PATH"` first.
- `npm start` → http://localhost:4173 · `npm test` → must stay green (**87 tests**).
- Google Chrome is installed: you can verify layout and behaviour **headlessly**
  (Chrome `--headless=new` + the DevTools protocol) at **390×844** and **1440×900**. That is how the
  mobile/desktop checks here were done — use it instead of guessing.
- The running build stamp is exposed at `/health` and `/api/market` (`version`).

**Rules (repo conventions — don't break them)**
- **Zero runtime dependencies.** Pure logic goes in `src/lib.js` and gets a unit test.
- **Never fake a number.** Missing data shows `—` / `n/a` and is labelled; every figure carries a
  **source + as-of date**. Honest over impressive.
- Keep `server.js` and `public/app.js` thin; put testable logic in `src/lib.js`.
- After **any** front-end change, bump `?v=` on `style.css` / `app.js` in `public/index.html`.
- Deploy = `git push origin main` → Render rebuilds in ~2–3 min. **Then verify on the live URL**
  `https://oil-market-desk.onrender.com` (poll for the new `?v=`, then check the change).
- `.github/workflows/*` is untracked on purpose — don't add it.
- Server caches linger (news 45 min, marketread 10 min, `movewho:` 6 h **per id+date**) — use fresh
  dates or restart the server when testing.

**How Marlon likes it**
- **One item at a time.** For anything big or design-y, **brainstorm first** and agree the approach,
  then code + tests + deploy + verify live, then report what changed. Don't batch features.
- Copy is **plain and professional**: short, factual, no hype, no decorative emoji. Not "AI-sounding".
- If something is unclear, ask one crisp question rather than guessing.

**TASK:** _<describe what you want, and attach a screenshot if it is a visual bug>_

---

## Useful one-liners
```bash
export PATH="$HOME/.local/node/bin:$PATH"     # Node
cd ~/projects/oil-basis
npm start                                     # http://localhost:4173 (zero-dep)
npm test                                      # node:test — keep green
curl -s localhost:4173/health                 # { ok, uptime, version }
curl -s localhost:4173/api/market | head -c 200
git push origin main                          # deploy (Render, ~2–3 min)
```
