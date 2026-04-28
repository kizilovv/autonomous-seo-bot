# autonomous-seo-bot

An autonomous SEO content service. Pulls Google Search Console + GA4, classifies
ranking opportunities, generates rewrites via OpenRouter LLM tiers, and applies
low-risk changes to a SQLite-backed CMS that's exposed over HTTP (read-only) and
MCP (write).

Built to run unattended on a single VPS with a daily cron pipeline.

## Why

Most SEO automation tools are dashboards that point at problems and ask a human
to fix them. This bot writes the fix, runs a risk gate against it, applies
low-risk changes itself, and routes anything visible-on-page to a Telegram
review queue. Spend is hard-capped per day and per month so it can't run away.

## Architecture

```
                     ┌───────────────────────┐
   GSC + GA4 (cron)  │  workers/pull         │  →  gsc_snapshots, ga4_snapshots
                     ├───────────────────────┤
                     │  workers/analyze      │  →  opportunities (5 kinds)
                     ├───────────────────────┤
                     │  workers/generate     │  →  proposals (OpenRouter, tier-routed, cached, budgeted)
                     ├───────────────────────┤
                     │  workers/apply        │  →  risk gate decides: auto / review / block
                     ├───────────────────────┤
                     │  workers/verify       │  →  fetch live page, confirm needle rendered
                     ├───────────────────────┤
                     │  workers/blog-gen     │  →  full 1200-1800 word blog posts for orphan clusters
                     ├───────────────────────┤
                     │  workers/daily-report │  →  Telegram digest: trends, applied, pending, spend
                     └───────────────────────┘
                              │      ▲
                              ▼      │
                       ┌────────────────────┐
                       │  SQLite (seo.db)   │   single file, WAL, audit-triggered history
                       └────────────────────┘
                          │              │
                  read    │              │   write
                  (HTTP)  ▼              ▼   (MCP, stdio)
                  ┌─────────────┐  ┌────────────────────┐
                  │ Fastify API │  │ MCP server (tools) │
                  │  :9100      │  │  seo.update_content│
                  └─────────────┘  │  seo.rollback ...  │
                  loopback only    └────────────────────┘
                  (frontend SSR)   (Claude Code, Cursor)
```

If the bot is offline, your frontend should transparently fall back to bundled
i18n strings — the bot's job is to *enrich* SEO, not to serve it.

## Opportunity kinds

| Kind | Trigger | Field | Risk | Auto |
|---|---|---|---|---|
| `snippet_rewrite` | top-10 ranking, CTR < 80% expected, ≥30 imps | `description` | low | ✅ |
| `ctr_regression` | same SERP pos vs prior 28d, clicks dropped >30% | `description` | low | ✅ |
| `rank_push` | pos 4-10, ≥10 imps, query NOT in H1/intro | `intro_extra` | low | ✅ (append) |
| `content_enrich` | pos 11-20, ≥10 imps | `faq` | medium | ✅ (append+dedup) |
| `lost_ranking` | was ≤10, now > 30 | n/a | high | ⛔ blocked |
| `schema_gap` | (reserved) | varies | medium | ⛔ |

The risk gate (`src/apply/risk-gate.ts`) is the single source of truth for what
the bot is allowed to do without a human. Tighten it (set `AUTO_APPLY_LOW_RISK=false`)
to put everything on review.

## OpenRouter tier routing

Three tiers, each a fallback chain. First model that responds wins. Spend is
estimated per-call from token counts and recorded in `llm_spend` /
`llm_spend_monthly`. When daily or monthly cap is hit, the generator stops mid-
batch and queued opportunities just wait for tomorrow.

| Tier | Default chain | Used for |
|---|---|---|
| 1 | `deepseek/deepseek-chat` → `anthropic/claude-haiku-4.5` → `openai/gpt-4o-mini` | snippet rewrites, FAQ items |
| 2 | `anthropic/claude-sonnet-4.5` → `claude-sonnet-4` → `deepseek/deepseek-chat` | rank-push body paragraphs |
| 3 | `anthropic/claude-sonnet-4.5` → `claude-sonnet-4` → `deepseek/deepseek-chat` | full blog posts |

Edit `src/llm/openrouter.ts` to swap the model lists.

## MCP write surface

The bot's only write API is MCP. Run the stdio server and connect any MCP client:

```bash
npm run mcp
# or built:
node dist/src/mcp/server.js
```

Tools:

- `seo.list_pages` — list every (locale, path) tuple with at least one field.
- `seo.get_content` — fetch all fields for a page.
- `seo.update_content` — upsert one field. Audited.
- `seo.delete_content` — soft-delete (active=0).
- `seo.rollback` — restore from a `content_history` row.
- `seo.history` — list change log for a page.
- `seo.set_sitemap_priority` — set sitemap.xml priority/changefreq overrides.

Every write goes through `content_history` via SQLite triggers, so rollback is
always one MCP call.

## HTTP read surface

| Endpoint | What |
|---|---|
| `GET /healthz` | liveness |
| `GET /v1/content?locale=&path=` | resolved fields for a page |
| `GET /v1/sitemap-extras?locale=` | optional priority/changefreq overrides |
| `GET /v1/pages` | list of (locale, path) tuples that have content |
| `GET /v1/blog?locale=&limit=` | published blog posts |
| `GET /v1/blog/post?locale=&slug=` | one blog post (full body + faq) |
| `GET /v1/blog/sitemap` | all published slugs (for sitemap generators) |

By default the server binds to `127.0.0.1:9100` — frontend instances on the
same host hit it via loopback. Don't expose it publicly; there's no auth.

## Quick start

```bash
git clone https://github.com/<you>/autonomous-seo-bot.git
cd autonomous-seo-bot
npm install
cp .env.example .env
# fill in OPENROUTER_API_KEY, GA4_PROPERTY_ID, GSC_SITES, BRAND_BLURB
npm run migrate
npm run seed -- ./seed.example.json
npm run dev
```

Now hit it:

```bash
curl http://127.0.0.1:9100/healthz
curl 'http://127.0.0.1:9100/v1/content?locale=en&path=/'
```

## Production deploy

The bot is one Node process. PM2 example in [`ecosystem.config.cjs`](ecosystem.config.cjs).

```bash
npm run build
pm2 start ecosystem.config.cjs
pm2 save
```

You'll need:

- A Google service account JSON file with **Search Console** + **GA4 Data API**
  read access. Add the SA email to your GSC property and your GA4 property as a
  viewer. Path goes in `GOOGLE_APPLICATION_CREDENTIALS`.
- An OpenRouter API key with a credit balance (start with $1-5; the bot's daily
  cap defaults to $1).
- (Optional) A Telegram bot token + chat ID for daily digests.

## Frontend wiring (Next.js example)

```ts
// app/lib/seo-cms.ts — fetch with timeout + Next.js cache + bundled fallback
const SEO_CMS_URL = process.env.SEO_CMS_URL ?? "http://127.0.0.1:9100";

export async function getSeoContent(locale: string, path: string) {
  try {
    const res = await fetch(
      `${SEO_CMS_URL}/v1/content?locale=${locale}&path=${encodeURIComponent(path)}`,
      { signal: AbortSignal.timeout(800), next: { revalidate: 300 } }
    );
    if (!res.ok) return null;
    return (await res.json()) as { fields: Record<string, unknown> };
  } catch {
    return null; // fall back to bundled messages/{locale}.json
  }
}
```

That's it. `generateMetadata` calls `getSeoContent`, falls back to your bundled
i18n strings if the bot is unreachable, and your site never breaks.

## Configuration

All runtime config is in `.env`. See [`.env.example`](.env.example) for every
variable. The hot-tunable ones (no code change required, just `pm2 restart`):

| Env | Default | What |
|---|---|---|
| `AUTO_APPLY_LOW_RISK` | `true` | flip to `false` for observation mode (everything goes to review) |
| `MAX_AUTO_CHANGES_PER_DAY` | `20` | hard cap on auto-applies per UTC day |
| `OPENROUTER_DAILY_BUDGET_USD` | `1.00` | generator stops mid-batch when reached |
| `OPENROUTER_MONTHLY_BUDGET_USD` | `30.00` | same, monthly |
| `BRAND_BLURB` | `""` | system context for every LLM prompt — your hard facts |
| `BRAND_TERMS_REGEX` | `""` | navigational queries to skip in the classifier |
| `GSC_SITES` | `""` | comma-separated `sc-domain:` properties |
| `SITE_URLS` | `""` | `locale=url` map used by the verify worker |

## Manual ops

```bash
# trigger a single worker (rebuild dist first if you changed code)
node dist/scripts/run-now.js pull
node dist/scripts/run-now.js analyze
node dist/scripts/run-now.js generate
node dist/scripts/run-now.js apply
node dist/scripts/run-now.js verify
node dist/scripts/run-now.js daily-report
node dist/scripts/run-now.js blog
node dist/scripts/run-now.js full   # pull → analyze → generate → apply → blog → report

# inspect a pending opportunity
sqlite3 ./data/seo.db 'SELECT id, kind, locale, path, query, substr(proposed_value,1,200) FROM opportunities ORDER BY id DESC LIMIT 20;'
```

## Roadmap / phases

- ✅ Phase 0 — read-only API + MCP write surface + frontend wiring
- ✅ Phase 1 — daily GSC + GA4 pulls into snapshots + Telegram report
- ✅ Phase 2 — opportunity classifier + OpenRouter generator with budget cap
- ✅ Phase 3 — auto-apply for low-risk, Telegram review for medium-risk
- ✅ Phase 4 — verify pipeline (live HTML containment + sparing GSC URL Inspect)
- ✅ Phase 5 — full blog post generator for orphan clusters
- ⬜ Phase 6 (opt) — admin UI for manual review / browse history

See [`docs/PIPELINE.md`](docs/PIPELINE.md) for the cron schedule + risk-gate
flow + failure modes in detail.

## License

MIT. See [LICENSE](LICENSE).
