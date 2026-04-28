# SEO pipeline — full reference

Each step is a worker; all run via cron under `node-cron` UTC.

## Daily schedule

| UTC | Worker | What it does |
|---|---|---|
| 06:00 | `pull` | Pull last 28d GSC for every `GSC_SITES` entry and GA4 for `GA4_PROPERTY_ID` into `gsc_snapshots` + `ga4_snapshots`. Purges anything > 120 days. |
| 06:30 | `analyze` | Run `classifier.ts` over current 28d vs prior 28d. Emits opportunities of 5 kinds. |
| 07:00 | `generate` | For pending opportunities w/o proposals, call OpenRouter (tier 1 → tier 2 fallback) to produce title / description / intro / FAQ. Stops at daily budget cap. |
| 07:30 | `apply` | Risk-gate: auto-apply low-risk up to `MAX_AUTO_CHANGES_PER_DAY`; everything else stays `pending` and is summarised in the daily digest. |
| 08:00 | `blog-generator` | Cluster GSC queries; generate full 1200-1800 word posts for orphan high-impression clusters via tier 3. |
| 08:30 | `daily-report` | Telegram digest: per-site clicks/imps trend (7d vs prior 7d), pending opportunities by kind, recent applies, LLM spend. |
| 18:00 | `verify` | For everything applied in last 24h, fetch the live page, confirm new value rendered. Spare GSC URL Inspect (≤5 calls/run) for title/description changes. |

Each worker logs its execution into the `runs` table. Rerun any of them by hand:

```bash
node dist/scripts/run-now.js <worker>
```

## Opportunity kinds (classifier)

See [`src/analyze/classifier.ts`](../src/analyze/classifier.ts) for thresholds.

| Kind | Trigger | Field | Risk | Auto |
|---|---|---|---|---|
| `snippet_rewrite` | top-10, CTR < 80% expected, ≥30 imps | `description` | low | ✅ |
| `ctr_regression` | same SERP pos vs prior 28d, clicks dropped >30%, ≥5 prior clicks | `description` | low | ✅ |
| `rank_push` | pos 4-10, ≥10 imps, query NOT in H1/intro | `intro_extra` | low | ✅ (append-only) |
| `content_enrich` | pos 11-20, ≥10 imps | `faq` | medium | ✅ (append-with-dedup) |
| `lost_ranking` | was ≤10 last window, now > 30 | n/a | high | ⛔ block |
| `schema_gap` | (reserved) | varies | medium | ⛔ |

`MIN_IMPRESSIONS_FOR_DETECTION` is 5 by default — long-tail queries become
opportunities even if they don't rank yet, because the cumulative impression
count is what matters for the bot's daily output, not any single query.

## Generator prompts

`src/generate/generators.ts` enforces:

- Brand facts only (your `BRAND_BLURB`) — no invented features.
- Locale-correct output (Cyrillic for `ru`, English for `en`).
- Title 50-60 chars, description 140-160 chars, intro 60-110 words.
- No greetings, no SEO clichés (forbidden-phrases list baked into the prompt).
- FAQ items must be valid `{q, a}` JSON or the generator rejects.

`src/generate/blog-post.ts` extends this for full-post generation: 1200-1800
word body, 4-6 H2 sections, FAQ block, structured JSON envelope.

## Risk gate flow

```
opportunity proposed_value ready
        │
        ├─ kind ∈ {snippet_rewrite, ctr_regression}
        │   AND field ∈ {title, description}
        │   → upsertContent() with source='bot:auto'
        │
        ├─ kind = rank_push AND field = intro_extra
        │   → upsertContent() (append-only paragraph)
        │
        ├─ kind = content_enrich AND field = faq
        │   → upsertContent() (append {q,a}, de-dup by q)
        │
        ├─ kind = lost_ranking
        │   → reject with notes="manual investigation required"
        │
        ├─ kind = schema_gap
        │   → review (no auto)
        │
        └─ AUTO_APPLY_LOW_RISK=false
            → all opportunities stay pending (observation mode)
```

The applier checks `MAX_AUTO_CHANGES_PER_DAY` before each auto-apply. When the
cap is reached, the rest of the queue stays `pending` and gets surfaced in the
daily digest.

## Hot tunables

Edit `.env` then `pm2 restart`:

- `AUTO_APPLY_LOW_RISK=false` — pause auto-apply, observation mode
- `MAX_AUTO_CHANGES_PER_DAY=20` — daily cap on auto applies
- `OPENROUTER_DAILY_BUDGET_USD=1.00` — soft cap before generator stops
- `OPENROUTER_MONTHLY_BUDGET_USD=30.00`
- `GSC_SITES=...` — comma-separated list of `sc-domain:` properties
- `BRAND_BLURB=...` — what the LLM is allowed to claim about your product

## Failure modes (graceful)

- Bot crashes → frontend `getSeoContent()` times out at 800ms, falls back to
  bundled `messages/{locale}.json`. No site impact.
- OpenRouter free models 429/404 → falls back to paid tiers automatically.
  Spend goes up but pipeline keeps working.
- Daily budget hit → generator stops mid-batch, queued opportunities remain
  `pending`, picked up tomorrow.
- GSC 401 → boot diagnostic in logs (`auth.getClient()` fails); SA permission
  revoked or hasn't propagated. Re-add SA in GSC.
- Bot writes a regression → MCP `seo.history` shows audit, `seo.rollback
  {history_id}` restores in one call.

## Cost reference (rough)

A typical day with ~20 opportunities and 1-2 blog posts costs $0.05–$0.30 via
DeepSeek/Haiku for snippets and Sonnet for blogs. Monthly cap of $30 is
conservative; you can run this on $5/month if you stick to tier-1 models.

## Schema

12 tables — see [`migrations/`](../migrations/):

- `content` — live SEO state served via HTTP
- `content_history` — append-only audit log (trigger-populated)
- `sitemap_extras` — bot-managed sitemap.xml overrides
- `gsc_snapshots`, `ga4_snapshots` — daily pulls
- `opportunities` — classified action items
- `llm_cache`, `llm_spend`, `llm_spend_monthly` — OpenRouter cache + spend
- `runs` — cron job execution log
- `generated_blogs`, `blog_topics` — full blog post pipeline
- `meta`, `_migrations` — schema metadata
