/** Match actual HTML text/attributes, not Next.js hydration payloads. */
function normalize(value: string): string {
  const named: Record<string, string> = {amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " "};
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (all, entity: string) => {
    if (entity.startsWith("#")) {
      const n = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
    }
    return named[entity.toLowerCase()] ?? all;
  }).replace(/\s+/g, " ").trim().toLowerCase();
}
export function renderedContains(html: string, needle: string): boolean {
  const visible = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  return normalize(visible).includes(normalize(needle)) || normalize(visible.replace(/<[^>]*>/g, " ")).includes(normalize(needle));
}
