# SEO pipeline — full reference

Live on Koara. Each step is a worker; all run via cron under `node-cron` UTC.

## Daily schedule

| UTC time | Worker | What it does |
|---|---|---|
| 06:00 | `pull` | Pull last 28d GSC (`csboard.com` + `csboard.trade`) and GA4 (property `337655668`) into `gsc_snapshots` + `ga4_snapshots`. Purges anything > 120 days. |
| 06:30 | `analyze` | Run `classifier.ts` over current 28d vs prior 28d. Emits opportunities of 5 kinds. |
| 07:00 | `generate` | For pending opportunities w/o proposals, call OpenRouter (tier 1 free → cheap) to produce title / description / intro / FAQ. Stops at daily budget cap. |
| 07:30 | `apply` | Risk-gate: auto-apply low-risk (snippet_rewrite + ctr_regression metadata only) up to `MAX_AUTO_CHANGES_PER_DAY`; everything else → Telegram review message. |
| 08:00 | `daily-report` | Post a Telegram digest: per-site clicks/imps trend (7d vs prior 7d), pending opportunities by kind, recent applies, LLM spend. |
| 18:00 | `verify` | For everything applied in last 24h, fetch the live page, confirm new value rendered. Spare GSC URL Inspect (≤5 calls/run) for title/description changes. |

## Opportunity kinds (classifier)

| Kind | Trigger | Field | Risk | Auto |
|---|---|---|---|---|
| `snippet_rewrite` | top-10 with CTR < 50% expected, ≥50 imps | `description` | low | ✅ |
| `ctr_regression` | same SERP pos, clicks dropped >30% vs prior 28d | `description` | low | ✅ |
| `rank_push` | pos 4–10, ≥30 imps, query NOT in H1/intro | `intro_extra` | low | ❌ (review) |
| `content_enrich` | pos 11–20, ≥30 imps | `faq` (append) | medium | ❌ (review) |
| `lost_ranking` | was ≤10 last window, now > 30 | n/a | high | ❌ (block) |
| `schema_gap` | (reserved for future) | varies | medium | ❌ |

## Generator prompts (anti "обоссанные лендинги")

`src/generate/generators.ts` enforces:
- Brand facts only (instant USDT, P2P, ~36k skins, zero fees) — no invented features.
- `ru` outputs in Cyrillic, `en` in English.
- Title 50–60 chars, description 140–160 chars, intro 60–110 words.
- No greetings, no SEO clichés ("welcome to the world…", "in today's market…").
- FAQ items must be valid `{q,a}` JSON or the generator rejects.

## OpenRouter model preference

| Tier | Models tried (in order) | Used for |
|---|---|---|
| 1 | `meta-llama/llama-3.3-70b-instruct:free` → `google/gemini-2.0-flash-exp:free` → `deepseek/deepseek-chat` → `anthropic/claude-3.5-haiku` | snippet rewrites, FAQ items, intro paragraphs |
| 2 | `anthropic/claude-3.5-sonnet` → `openai/gpt-4o-mini` | (reserved — not currently called) |

Cost recorded per call into `llm_spend` (daily) + `llm_spend_monthly`. Caps:
- daily $0.30, monthly $9.00 (set on `/srv/csboard-seo/.env`).

## Risk gate flow

```
opportunity proposed_value ready
        │
        ├─ kind ∈ {snippet_rewrite, ctr_regression}
        │   AND field ∈ {title, description}
        │   AND auto_count_today < MAX_AUTO_CHANGES_PER_DAY
        │   AND AUTO_APPLY_LOW_RISK=true
        │   → upsertContent() with source='bot:auto'
        │
        ├─ kind ∈ {rank_push, content_enrich}
        │   → sendMessage(Telegram review preview)
        │
        ├─ kind = lost_ranking
        │   → reject with notes="manual investigation required"
        │
        └─ AUTO_APPLY_LOW_RISK=false
            → all opportunities go to review (observation mode)
```

## Manual ops

```bash
# trigger single workers (rebuild dist first if you changed code)
ssh root@95.217.106.61 "cd /srv/csboard-seo && node dist/scripts/run-now.js pull"
ssh root@95.217.106.61 "cd /srv/csboard-seo && node dist/scripts/run-now.js analyze"
ssh root@95.217.106.61 "cd /srv/csboard-seo && node dist/scripts/run-now.js generate"
ssh root@95.217.106.61 "cd /srv/csboard-seo && node dist/scripts/run-now.js apply"
ssh root@95.217.106.61 "cd /srv/csboard-seo && node dist/scripts/run-now.js daily-report"
ssh root@95.217.106.61 "cd /srv/csboard-seo && node dist/scripts/run-now.js verify"
ssh root@95.217.106.61 "cd /srv/csboard-seo && node dist/scripts/run-now.js full"   # pull→analyze→generate→report

# review a specific opportunity
ssh root@95.217.106.61 "sqlite3 /srv/csboard-seo/data/seo.db 'SELECT id, kind, locale, path, query, status, substr(proposed_value,1,200) FROM opportunities ORDER BY id DESC LIMIT 20;'"

# manually approve a review-needed opportunity (e.g. id=5)
ssh root@95.217.106.61 "sqlite3 /srv/csboard-seo/data/seo.db <<'SQL'
-- Inspect first
SELECT * FROM opportunities WHERE id = 5;
SQL"
# Then apply via MCP `seo.update_content` or directly:
ssh root@95.217.106.61 "node -e \"
import('/srv/csboard-seo/dist/src/db/migrate.js').then(({runMigrations}) => {
  runMigrations();
  return import('/srv/csboard-seo/dist/src/db/repo.js');
}).then(({getDb, upsertContent, applyOpportunity}) => {
  const db = getDb();
  const o = db.prepare('SELECT * FROM opportunities WHERE id=?').get(5);
  const value = JSON.parse(o.proposed_value);
  const r = upsertContent({locale:o.locale, path:o.path, field:o.field, value, source:'manual:artem', reason:'TG-approved'});
  applyOpportunity(o.id, r.id);
  console.log('applied:', r);
});
\""
```

## Hot tunables (no code change required)

Edit `/srv/csboard-seo/.env`, then `pm2 restart csboard-seo-bot`:
- `AUTO_APPLY_LOW_RISK=false` — pause auto-apply, observation mode
- `MAX_AUTO_CHANGES_PER_DAY=20` — daily cap on auto applies
- `OPENROUTER_DAILY_BUDGET_USD=0.30` — soft cap before generator stops
- `OPENROUTER_MONTHLY_BUDGET_USD=9.00`
- `GSC_SITES=...` — comma-separated list of `sc-domain:` properties to track

## Failure modes

- Bot crashes → frontend `getSeoContent()` times out at 800ms, falls back to bundled `messages/{en,ru}.json`. No site impact.
- OpenRouter free models 429/404 → fallback to paid (Haiku → Sonnet). Cost goes up but pipeline keeps working.
- Daily budget hit → generator stops mid-batch, queues remain `pending`, picked up tomorrow.
- GSC 401 → boot diagnostic in logs (`auth.getClient()` fails); SA permission revoked. Manual re-add SA in GSC.
