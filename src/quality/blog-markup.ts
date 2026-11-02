/** Narrow publication guard for HTML corruption observed in generated article608.
 * This is not a sanitizer, a complete HTML parser, or a factual quality score.
 * Comparisons such as float < 0.1 are text; markup-like tokens need valid tags.
 */
const TAGS = new Set('a abbr b blockquote br caption cite code col colgroup dd del details div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 hr i img kbd li mark ol p pre s small span strong sub summary sup table tbody td th thead tr u ul'.split(' '));
export function blogMarkupIssues(html: string): string[] {
  const issues = new Set<string>();
  const content = html.replace(/<!--[\s\S]*?-->/g, '');
  if (/<\s*%/u.test(content)) issues.add('Malformed HTML markup: invalid percent tag');
  for (const match of content.matchAll(/<\/?([a-zA-Z][^\s<>/]*)([^<>]*)(>|(?=<)|$)/gu)) {
    const tag = match[1].toLowerCase();
    if (!TAGS.has(tag) || match[3] !== '>') issues.add('Malformed HTML markup: unknown or unterminated tag');
  }
  return [...issues];
}

export function blogBlockMarkupIssues(value: unknown): string[] {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return ['Malformed body_blocks JSON']; }
  }
  if (value == null) return [];
  // Check every rendered string: table cells and FAQ answers can contain HTML
  // too, even if body_html happens to be clean.
  const visit = (v: unknown): string[] => typeof v === 'string' ? blogMarkupIssues(v)
    : Array.isArray(v) ? v.flatMap(visit)
    : v && typeof v === 'object' ? Object.values(v).flatMap(visit) : [];
  return [...new Set(visit(value))];
}
