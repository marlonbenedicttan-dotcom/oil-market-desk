# Security policy

## Reporting a vulnerability

Email **marlonbenedicttan@gmail.com** with:

- a short description
- the affected URL or endpoint
- reproduction steps
- any relevant logs or screenshots

Please do not open a public issue for an unfixed vulnerability.

## Scope

In scope:

- the public site and JSON API
- authentication, rate limiting and access-control bypasses
- cross-site scripting, request forgery and injection
- leaked secrets, tokens or private data

Out of scope:

- denial-of-service, load testing or spam
- social engineering, phishing or physical access
- automated scanner output without a working reproduction
- missing headers with no practical exploit

## Safe harbour

Good-faith research that avoids privacy violations, data destruction and service disruption will not be pursued. Do not access, modify or retain data that is not yours.

## No bounty

This is a personal project. There is no paid bounty. Confirmed reports are credited if requested.

## Supported version

Only the current `main` branch and the deployed site are supported.

## What is already implemented

- CSP with script hashes, frame denial, COOP, CORP, nosniff and a permissions policy
- HSTS when TLS is terminated
- per-IP API rate limiting
- same-origin JSON checks on POST routes
- constant-time basic-auth comparison
- optional HTTP basic auth for the whole site
- no runtime npm dependencies
- GitHub Actions with least-privilege permissions
- a public `security.txt` and `robots.txt` AI crawler policy

## External controls

Some controls live in the GitHub, Render and Cloudflare dashboards, not in this repository. See `docs/security-hardening.md` for the checklist.
