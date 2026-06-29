# csboard-seo-bot

Autonomous SEO content service for csboard.com / csboard.trade.

**Isolated by design.** Bot owns its own SQLite DB. CSBoard frontend reads via a
read-only HTTP API. Bot has zero write access to the CSBoard production database.

## Architecture

```
SQLite (seo.db, single file)
  ↑ writes (bot/agents only via MCP)
  ↑ reads (frontend via HTTP /v1/content)

Workers (cron, Phase 1+):
  GSC pull → snapshots
  GA4 pull → snapshots
  Analyzer → opportunities
  Generator (OpenRouter) → proposals
  Applier → writes via MCP into content
  Verifier → Lighthouse + GSC URL Inspect
```

If the bot is offline, the frontend transparently falls back to bundled
`messages/{en,ru}.json` — site never breaks.

## Endpoints

| Endpoint | Type | What |
|---|---|---|
| `GET /healthz` | HTTP | liveness |
| `GET /v1/content?locale=&path=` | HTTP | resolved fields for a page |
| `GET /v1/sitemap-extras?locale=` | HTTP | optional priority/changefreq overrides |
| `GET /v1/pages` | HTTP | list of (locale, path) tuples that have content |
| `seo.list_pages` | MCP | same as above |
| `seo.get_content` | MCP | fetch fields for a (locale, path) |
| `seo.update_content` | MCP | upsert one field with audit trail |
| `seo.delete_content` | MCP | soft-delete (active=0) |
| `seo.rollback` | MCP | restore from history entry |
| `seo.history` | MCP | full change log for a page |
| `seo.set_sitemap_priority` | MCP | tweak sitemap metadata |

## Local dev

```bash
npm install
npm run migrate
npm run seed                     # pulls from ../cs2-tradeboard-frontend-dev/messages
npm run dev                      # tsx watch on port 9100
curl http://127.0.0.1:9100/healthz
curl 'http://127.0.0.1:9100/v1/content?locale=en&path=/sell'
```

MCP server (stdio) for ad-hoc agent use:

```bash
npm run mcp
```

In Claude Code: `claude mcp add csboard-seo -- node /Users/.../csboard-seo-bot/dist/src/mcp/server.js`

## Production deploy (Koara, 95.217.106.61)

1. Bring code up to date:
   ```bash
   ssh root@95.217.106.61 "mkdir -p /srv/csboard-seo /var/log/csboard-seo /srv/csboard-seo/data /srv/csboard-seo/.secrets"
   rsync -av --delete \
     --exclude node_modules --exclude data --exclude dist --exclude .git \
     ./ root@95.217.106.61:/srv/csboard-seo/
   ```

2. Install + build on server:
   ```bash
   ssh root@95.217.106.61 "cd /srv/csboard-seo && npm ci && npm run build"
   ```

3. Service account (already on Jarvis VPS — copy to Koara):
   ```bash
   scp root@108.165.173.252:/home/jarvis/jarvis-bot/config/google-service-account.json \
       root@95.217.106.61:/srv/csboard-seo/.secrets/google-service-account.json
   ssh root@95.217.106.61 "chmod 600 /srv/csboard-seo/.secrets/google-service-account.json"
   ```

4. `.env` on server (adapt from `.env.example`).

5. Migrate + seed once:
   ```bash
   ssh root@95.217.106.61 "cd /srv/csboard-seo && npm run migrate && npm run seed -- /srv/csboard.trade/cs2-tradeboard-frontend-dev"
   ```
   (point seed at whichever frontend worktree has the most up-to-date messages)

6. pm2:
   ```bash
   ssh root@95.217.106.61 "cd /srv/csboard-seo && pm2 start ecosystem.config.cjs && pm2 save"
   ```

7. Verify:
   ```bash
   ssh root@95.217.106.61 "curl -s http://127.0.0.1:9100/healthz && echo && curl -s 'http://127.0.0.1:9100/v1/content?locale=en&path=/sell' | head -c 400"
   ```

## Frontend wiring (csboard)

`cs2-tradeboard-frontend-dev/lib/seo-cms.ts` reads `process.env.SEO_CMS_URL`
(default `http://127.0.0.1:9100`). On Koara dev/prod the bot listens on the
loopback interface — frontend pods on the same host hit it locally.

If the dev server is on a different host, set `SEO_CMS_URL` in the frontend's
`.env.production` to a private network address (or front the bot behind nginx
with an internal-only `allow` rule).

## Safety guarantees

- HTTP API has **zero** write surface. Frontend cannot mutate state via this service.
- All writes go through MCP — every call is logged + audited via DB triggers.
- `content_history` table preserves every previous value; rollback is one MCP call.
- Bot has **no** access to `csboard-postgres-prod`, no GitHub PAT, no deploy keys.
- If bot dies → frontend falls back to bundled i18n (5-min cache + 800ms timeout).

## Roadmap

- Phase 0 (now) — read-only API + MCP write surface + frontend wiring ✅
- Phase 1 — daily GSC + GA4 pulls into snapshots, Telegram report (no writes yet)
- Phase 2 — opportunity classifier + OpenRouter dry-run (Telegram review)
- Phase 3 — auto-apply for low-risk fixes (i18n-only) with risk gate
- Phase 4 — verify pipeline (Lighthouse, GSC URL Inspect)
- Phase 5 — optional admin UI for manual review
