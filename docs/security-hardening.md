# Security hardening checklist

This is the practical checklist for Marlon's Watchtower. The code controls are in the repository. The account and edge controls have to be set in the GitHub, Render and Cloudflare dashboards.

## 1. Accounts

- [ ] Turn on a passkey or hardware-key second factor for GitHub.
- [ ] Turn on a passkey or hardware-key second factor for Render.
- [ ] Turn on a passkey or hardware-key second factor for Cloudflare.
- [ ] Turn on a second factor for the email account used for password resets.
- [ ] Remove collaborators, deploy keys, personal access tokens and OAuth apps that are not needed.
- [ ] Review the GitHub audit log and Render audit log once a month.

A compromised GitHub or Render account can change the deployed code without touching a single line of this repository. This is the highest-value control.

## 1a. Secrets

- [ ] Keep local keys in `.env`. It is ignored, and `.env.*` is ignored too; `.env.example` contains placeholders only.
- [ ] Keep CI keys in GitHub Actions secrets. The workflows reference `secrets.JQUANTS_API_KEY` and `secrets.DART_API_KEY`.
- [ ] Keep runtime keys in Render environment variables, never in the repository.
- [ ] Run `npm run check:secrets` before pushing. It scans tracked files and never prints the value.
- [ ] The pre-commit hook blocks `.env`, private-key files and common key patterns. Enable it with `npm run prepare`.
- [ ] Turn on GitHub secret scanning and push protection for the public repository.
- [ ] If a key has ever appeared in a chat, issue, screenshot or log, rotate it at the provider.

The paid J-Quants key belongs in two places only: your local `.env` and the GitHub Actions secret `JQUANTS_API_KEY`. The public repository contains the name, never the value.

## 2. GitHub repository

- [ ] Make the repository private if code copying is the concern. The deployed frontend JavaScript is still public; the server source is not. Private-repo Actions minutes are metered, and the weekly rebuild is about 4.5 hours, so check the plan before switching.
- [ ] Protect `main`: require a pull request, require the `test` check, block force pushes and deletions.
- [ ] Enable secret scanning and push protection.
- [ ] Enable Dependabot alerts and the GitHub Actions Dependabot updates.
- [ ] Keep `CODEOWNERS` current.
- [ ] Keep workflow `permissions:` minimal. The test workflow only needs `contents: read`.
- [ ] Pin third-party actions to a commit SHA, not a moving tag. The workflows already use the full SHA with a version comment.
- [ ] Store deployment secrets in GitHub Environments, not in repository variables.
- [ ] Do not use `pull_request_target` with untrusted code.

## 3. Render

- [ ] Keep `autoDeployTrigger: checksPass` so a red commit never reaches production.
- [ ] Set `AUTH_USER` and `AUTH_PASS` if the whole site should be private.
- [ ] Keep secrets in Render environment variables, never in the repository.
- [ ] Rotate `DART_API_KEY`, `EIA_API_KEY`, SMTP and webhook secrets after any suspected exposure.
- [ ] Keep the health check on `/health`; it is intentionally public.
- [ ] Confirm the free-tier disk wipe is acceptable, or move state to Upstash Redis.

## 4. Cloudflare

- [ ] Put the Render hostname behind Cloudflare with proxying enabled.
- [ ] Set SSL/TLS to Full (strict).
- [ ] Enable Bot Fight Mode.
- [ ] Add rate limiting for `/api/*` and for POST routes. Keep the origin rate limit as the second line of defence.
- [ ] Add Turnstile to any public form that sends email or writes state.
- [ ] Block the AI crawlers listed in `public/robots.txt` at the edge if the plan supports it.
- [ ] Create a Transform Rule that adds `X-Watchtower-Proxy` with a random secret.
- [ ] Set the same random value as `TRUSTED_PROXY_SECRET` in Render. The server only trusts `CF-Connecting-IP` when that header matches.
- [ ] Do not expose the Render hostname directly in public links; use the Cloudflare hostname.
- [ ] Add a WAF rule that blocks requests with obvious injection or scanner patterns.

## 5. Application

Already in place:

- CSP with script hashes, `frame-ancestors 'none'`, `object-src 'none'`
- COOP, CORP, nosniff, referrer policy and permissions policy
- HSTS when TLS is terminated
- per-IP API rate limiting
- same-origin JSON checks on POST routes
- constant-time basic-auth comparison
- optional basic auth
- no runtime npm dependencies
- `security.txt`, `robots.txt` and `ai.txt`

Remaining ideas:

- [ ] Move rate-limit buckets to Redis if the app ever runs more than one instance.
- [ ] Add a short request timeout to every outbound fetch. The CI already uses `scripts/fetch-timeout.mjs`.
- [ ] Add a Content-Security-Policy report endpoint if a report-only rollout is acceptable.
- [ ] Add a backup of `data/` and `.state.json` outside Render.

## 6. Monitoring and response

- [ ] Watch the GitHub Actions failure list and the Render deploy list.
- [ ] Watch `/health` for unexpected restarts or version changes.
- [ ] Alert on a burst of 401, 403 or 429 responses.
- [ ] Keep a rollback commit ready. Render can redeploy an older commit.
- [ ] If a secret leaks: rotate it first, then revoke sessions, then inspect logs.

## 7. Copy deterrence

Technical controls cannot stop a determined reader or AI from reading a public page. What actually helps:

- private repository for the server code
- `LICENSE` and `public/terms.html` with clear no-copy and no-training terms
- Cloudflare bot management and rate limits
- `robots.txt` and `ai.txt` as requests to compliant crawlers
- canary rows or watermarks in bulk exports if you need to trace a leak
- DMCA or takedown process for a copied site

Do not rely on right-click blockers, copy blockers, JavaScript obfuscation or user-agent blocking. They are trivial to bypass and create a false sense of security.
