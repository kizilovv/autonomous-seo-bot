-- 006 — schema-driven blog body blocks (Session #4 follow-up, 2026-05-18)
--
-- Adds:
--   body_blocks JSON column to generated_blogs
--
-- Why: existing body_html is a wall-of-text dump from the LLM. The new
-- structured-block format lets the frontend render typed React components
-- (hero, top_list, callout, item_grid, faq, cta) instead of dangerouslySetInnerHTML.
-- Old body_html is preserved as the fallback when body_blocks is NULL.
--
-- Block schema (single source of truth — also documented in
-- cs2-tradeboard-frontend/lib/blog-blocks.ts):
--
-- type BlogBlock =
--   | { type:"hero",     image?,title,eyebrow?,publishedAt? }
--   | { type:"tldr",     items:string[] }
--   | { type:"text",     html:string }
--   | { type:"top_list", title,items:[{rank,name,image?,stat?,note?,url?}] }
--   | { type:"callout",  style:"pro_tip"|"warning"|"info"|"did_you_know", title?,text }
--   | { type:"table",    title?,cols:string[],rows:string[][] }
--   | { type:"item_grid",title?,items:[{name,image,stat?,url}] }
--   | { type:"faq",      items:[{q,a}] }
--   | { type:"cta",      title,subtitle?,buttonText,buttonUrl,accent?:"green"|"blue"|"red" }

ALTER TABLE generated_blogs ADD COLUMN body_blocks TEXT;  -- JSON array, nullable

-- For audit visibility: when body_blocks is set, body_html may diverge from
-- the rendered output. The renderer prefers body_blocks if present.
CREATE INDEX IF NOT EXISTS idx_blogs_has_blocks ON generated_blogs (id) WHERE body_blocks IS NOT NULL;
