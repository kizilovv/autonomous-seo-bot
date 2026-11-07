import { commercialLandingForQuery } from "./commercial-intent.js";
/** Search queries are untrusted evidence, never instructions for the writer. */
export function queryEligibilityIssue(query: string | null | undefined): string | null {
  if (!query) return null;
  if (/\b(?:context|system|assistant|developer)\s*:|\bignore\s+(?:all\s+)?(?:previous|prior)\s+instructions\b|\b(?:output|respond|return)\s+(?:only\s+)?(?:json|markdown)\b|(?:контекст|системная инструкция)\s*:/iu.test(query)) {
    return 'instruction-shaped search query: needs intent review before generation';
  }
  if (/\b(?:site|inurl|intitle|intext|filetype|cache|related|allintitle|allinurl):/i.test(query)) {
    return 'search-operator query: not a content opportunity';
  }
  return null;
}

/** Automated drafts have no verified procedure brief. A query is not evidence
 * of a provider's payout flow. Applies to new/queued drafts, not site indexing. */
export function unsupportedPayoutTopicIssue(query: string): string | null {
  const text = query.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ');
  if (/\b(?:withdraw(?:al|als|ing|s)?|cash[\s-]*out|payouts?)\b|(?:^|\s)(?:вывод(?:а|е|ом|у)?|вывести|выводить|выплат(?:а|ы|у|е|ой)?)(?:\s|$)/iu.test(text)) {
    return 'Payout/support intent needs a verified provider procedure brief; do not substitute CSBoard for the queried service';
  }
  return null;
}

/** Observed unresolved entity, not a generic ban on competitor comparisons.
 * Re-enable only with a verified source brief; a query is not evidence of a framework. */
export function blogTopicEligibilityIssue(query: string): string | null {
  const issue = queryEligibilityIssue(query);
  if (issue) return issue;
  const payout = unsupportedPayoutTopicIssue(query);
  if (payout) return payout;
  const landing = commercialLandingForQuery(query);
  if (landing) return `transactional query belongs to existing ${landing} landing; improve that page instead of generating another blog`;
  if (/\bcs\s*:?\s*go\s*atse\b/iu.test(query)) {
    return 'CSGOATSE entity needs a verified source brief before automated drafting';
  }
  return null;
}
