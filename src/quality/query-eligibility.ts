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

/** Observed unresolved entity, not a generic ban on competitor comparisons.
 * Re-enable only with a verified source brief; a query is not evidence of a framework. */
export function blogTopicEligibilityIssue(query: string): string | null {
  const issue = queryEligibilityIssue(query);
  if (issue) return issue;
  if (/\bcs\s*:?\s*go\s*atse\b/iu.test(query)) {
    return 'CSGOATSE entity needs a verified source brief before automated drafting';
  }
  return null;
}
