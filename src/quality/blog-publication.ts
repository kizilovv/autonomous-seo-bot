import { commercialClaimViolation } from './commercial-facts.js';
import { blogReadabilityIssues } from './blog-readability.js';

/** Narrow regression checks for observed invented capabilities, not a full fact checker. */
export function productCapabilityIssues(value: string): string[] {
  const issues = new Set<string>();
  const text = value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  if (/authenticity\s*,?\s*tier\s*,?\s*supply\s*,?\s*(?:and|&)\s*exterior|\batse\s+(?:framework|method|system)\b/iu.test(text)) {
    issues.add('Unverified ATSE framework: preserve the queried entity; do not invent its expansion');
  }
  // Pattern tiers are supported only on Case Hardened and Heat Treated item pages.
  // Scan original links too: HTML stripping must not hide a fabricated destination.
  for (const match of value.matchAll(/\/(?:en|ru)\/items\/([^\s"'<>?]+)\?[^\s"'<>]*\btier=/giu)) {
    if (!/(?:case-hardened|heat-treated)(?:-|$)/i.test(match[1])) {
      issues.add('Unsupported tier link: pattern tiers apply only to Case Hardened / Heat Treated items');
    }
  }
  if (/tier filter[^.!?]{0,60}(?:any|every|all)\s+(?:item|weapon|knife|categor)|(?:any|every|all)\s+(?:item|weapon|knife|categor)[^.!?]{0,60}tier filter/iu.test(text)) {
    issues.add('Unsupported universal tier filter claim');
  }
  // A review hold is deliberately conservative. Crypto discussion is allowed;
  // instructions to select a listing payout or direct buyer-wallet settlement need correction.
  if (/(?:bitcoin|btc|crypto)[^.!?]{0,100}(?:sent|send|paid|transferred)\s+directly[^.!?]{0,70}(?:buyer|wallet)|buyer[^.!?]{0,80}(?:send|pay|transfer)[^.!?]{0,60}(?:bitcoin|btc|crypto)|(?:select|choose|set)[^.!?]{0,30}(?:bitcoin|btc)[^.!?]{0,60}(?:payout|payment)|(?:выбер|выбира|укаж)[а-яё]*[^.!?]{0,40}(?:bitcoin|btc|биткоин)[^.!?]{0,60}(?:выплат|оплат)|покупател[а-яё]*[^.!?]{0,60}(?:отправ|перевод|плат)[а-яё]*[^.!?]{0,40}(?:биткоин|bitcoin|btc|крипт)/iu.test(text)) {
    issues.add('Unverified direct crypto payment or listing payout selection: monetary P2P sales use platform balance');
  }
  return [...issues];
}

export interface BlogContentForReview {
  title?: string | null;
  meta_title?: string | null;
  meta_description?: string | null;
  excerpt?: string | null;
  body_html: string;
  body_md?: string | null;
  faq?: unknown;
  body_blocks?: unknown;
}

export function blogPublicationIssues(draft: BlogContentForReview): string[] {
  // Both representations matter: the storefront prefers body_blocks over body_html.
  const value = [draft.title, draft.meta_title, draft.meta_description, draft.excerpt,
    draft.body_html, draft.body_md, typeof draft.faq === 'string' ? draft.faq : JSON.stringify(draft.faq),
    typeof draft.body_blocks === 'string' ? draft.body_blocks : JSON.stringify(draft.body_blocks)].filter(Boolean).join('\n');
  const issues = [...blogReadabilityIssues(draft.body_html), ...productCapabilityIssues(value)];
  const commercial = commercialClaimViolation(value, 'editorial');
  if (commercial) issues.push(commercial);
  return [...new Set(issues)];
}

export class BlogQualityError extends Error {
  constructor(public readonly issues: string[]) {
    super('Blog requires factual correction: ' + issues.join('; '));
    this.name = 'BlogQualityError';
  }
}
