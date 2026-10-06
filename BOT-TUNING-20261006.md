# SEO bot measurement and publication guard patch

Status: deployment preparation; results will be recorded after production verification.
Base: c2a049f (fetched from live hz:/srv/csboard-seo), preserving the three production-only commits absent from origin/main.

## Changes
- GA4: paginate ordered rows beyond 5,000; fail rather than persist a truncated page; atomic window replacement makes retries idempotent. Migration 009 adds explicit window_start/window_end. Historical unprovenanced rows remain NULL; overlapping 28-day totals must never be summed as daily metrics. No stream filter is invented; hosts/channels remain explicit dimensions.
- CTR: recompute exact page + query before/after seven-day periods, skipping seven recrawl days and waiting sixteen days. Require complete property-date coverage and 100 impressions each side; rollback additionally requires >=20 baseline clicks and comparable impressions. Human pins, newer opportunities and changed content prohibit rollback. Skipped rollbacks no longer claim a successful reversion. Historical feedback labels are not rewritten.
- Verification: decode HTML entities, normalize whitespace, ignore script/style payloads so hydration-only strings do not count as visible content.
- Sitemap: remove scheduled PUT attempts because current OAuth client is read-only. No scope expansion, sitemap deletion, or claim that submission guarantees recrawl.
- Blog readability: paragraphs above 120 words, repeated substantial paragraphs, placeholders, and long unstructured articles enter the existing pending_approval path. Passing this mechanical gate does not certify accuracy or editorial quality. Existing published articles are untouched.
- Existing package-lock could not pass npm ci (manifest Google auth/searchconsole mismatch). Lock reconciled to existing dependency declarations, no deliberate version-policy changes.

## Validation
npm run typecheck; npm run build; git diff --check passed.
Four regression groups pass via npm test: encoded/hydration HTML, readability, SQLite migration+window retry+exact-page CTR+pin guard, 5,001-row GA4 pagination and interrupted snapshot preservation.
Dependencies: compatible npm audit fixes removed all 9 high and 1 critical advisories. Four remain (1 low development esbuild/Windows advisory, 3 moderate uuid-related). No major node-cron upgrade or audit fix --force performed. Added SEO_BOT_SILENT_START=1 support to suppress the existing startup notification during this deployment.

## Deployment plan (not executed)
1. Review and commit only this worktree patch; confirm live HEAD still c2a049f or incorporate new live commits. Never overwrite production-only commits with origin/main.
2. On hz, run as deploy in /srv/csboard-seo. Record Git HEAD and PM2 csboard-seo-bot configuration; ensure clean tracked files. Preserve .env, data, untracked scripts and credential files.
3. Take a consistent SQLite backup using sqlite backup API (not copying a live WAL DB), and save prior dist and package-lock. Stage exact reviewed commit in a sibling release directory, npm ci and npm run build there. Check audit risk before installation; never use old Koara README host.
4. Apply additive migration 009 against a backup copy and smoke-test reads first. Then stop only PM2 csboard-seo-bot for the short live migration/code switch, apply migration, install compiled exact release and restart the same deploy-owned PM2 process. No frontend/API/Steam worker restart. Entry point also runs migrations idempotently.
5. Verify localhost:9100/healthz, existing CMS GET endpoints and PID/restart count. Check GA4 next completed pull contains >5,000 if source has that many, with explicit window provenance; no sitemap403 loop. Do not run the full auto-apply/blog pipeline as a smoke test (it writes and notifies).
6. Rollback code/dist to recorded release and restart only the same process if unhealthy. Additive GA4 columns can remain; restoring the DB would lose post-release changes and is unnecessary unless data corruption is proven. Preserve the backup for investigation.

References: https://developers.google.com/analytics/devguides/reporting/data/v1/basics (limit/offset pagination); https://developers.google.com/webmaster-tools/v1/sitemaps/submit (requires webmasters write scope).
