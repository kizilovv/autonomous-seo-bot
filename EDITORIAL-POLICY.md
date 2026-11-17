# automatic retail editorial policy

Version: retail-evidence-v1, 2026-11-07.

The scheduled blog worker no longer sends approval requests or uses
SEO_BOT_BLOG_APPROVAL. It publishes only after deterministic checks, fresh
first-party source retrieval, link checks, and a separate skeptical LLM review.
A failed review archives the draft and records the reasons. An unavailable
review/source never permits publication. Existing published/human content is
not rewritten by this change. Existing pending drafts are reviewed automatically,
with at most two eligible review attempts per scheduled run.

Topics must support a concrete skin buying/selling decision. Head buy/sell
queries remain owned by existing commercial landing pages; no competing blog
is created. Withdrawal/support, gambling, freebies and investment-return topics
are outside this worker. The B2B pipeline is separate.

Evidence is fetched from server-rendered /en|ru/buy and /en|ru/sell plus the
versioned owner-confirmed commercial policy. No blog is used as a factual
source. Sources include retrieval times, hashes and exact text. Sources are
not instructions. New item-specific facts or third-party comparisons need an
additional vetted source adapter; model memory is not an acceptable source.
Evergreen articles cannot include monetary price amounts. Numbers of listings
or inventory and unverified availability must not be inferred from catalogue
pages. Internal links are restricted to public same-locale destinations and
checked for HTTP success without following redirects.

The independent review covers all representations (blocks, HTML, Markdown),
metadata and FAQ, with exact source quotations for factual claims. Every unit
must be accounted for. Invalid JSON, omitted units, nonexistent quotes, failed
quality checks, duplicate intent or stale/missing sources fail closed.
The source quote matching is deterministic; semantic entailment and completeness
are model judgments and can still be wrong. This is not a factual-accuracy
or ranking guarantee. Monitor rejected reasons and sample published content.

Successful decisions and their evidence are stored in blog_editorial_reviews
atomically with the publication. Existing pending rows use full-row compare
and swap to protect concurrent editorial changes. No automatic rewrite of
published articles. New generation is capped at one RU and one EN candidate
per run, while existing daily/monthly spend caps remain unchanged.

Checks: npm run build; npm test. The live canary uses a fabricated fee, a supported
buy/sell comparison and a duplicate-intent draft, with no publication. Rollout
must preserve published rows and human CMS edits; check deployed SHA and health.

## Evidence collection and outcome counters (2026-11-17)
- Public `/en|ru/buy` and `/en|ru/sell` remain fixed first-party sources. Parse HTML; resolve only completed React segments explicitly attached to the main content. Never execute JavaScript or use Flight JSON, metadata, unrelated hidden text, or Trustpilot testimonials as product evidence.
- Incomplete/client-only boundaries, missing main, oversized responses and unsupported locales still fail closed. Existing minimum/maximum evidence size and claim-by-claim checks remain mandatory. New collection version: `retail-evidence-v2-streamed`.
- An unavailable source leaves the topic queued for the next existing scheduled run. `blogs_evidence_deferred` counts the attempted topic; the batch stops before paid generation. It is not a quality approval or technical LLM failure.
- Snippet `quality_rejected` counts successful generations refused by the quality gate. `failed` counts generation exceptions. Rejected generation cost still stays in the cost total.
- Ranking and CTR regressions compare the same site, query and exact page URL across windows. Another page's previous position or clicks must never justify a rewrite. Keep existing historical records; do not rewrite old metrics to make this fix look like traffic growth.
