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
