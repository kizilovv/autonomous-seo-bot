/** Mechanical pre-publication checks. Passing is not a factual/editorial review. */
export function blogReadabilityIssues(html: string): string[] {
  const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const issues: string[] = [];
  const paragraphs = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(m => m[1].replace(/<[^>]*>/g, " ").trim());
  if (paragraphs.some(p => p.split(/\s+/).length > 120)) issues.push("paragraph exceeds 120 words");
  const substantial = paragraphs.filter(p => p.length > 100).map(p => p.toLowerCase().replace(/\s+/g, " "));
  if (new Set(substantial).size < substantial.length) issues.push("duplicated paragraph");
  if (/\b(?:TODO|TBD|Lorem ipsum)\b|\[(?:insert|add) [^\]]+\]/i.test(text)) issues.push("unresolved placeholder");
  if (text.split(/\s+/).length > 500 && (html.match(/<h[23]\b/gi) ?? []).length < 2) issues.push("long article without section headings");
  return issues;
}
