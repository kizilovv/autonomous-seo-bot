/** Reviewed against Valve's CS20 market container listing on 2026-11-01.
 * https://steamcommunity.com/market/listings/730/G18BD243004?count=100&start=0
 * Contents/rarity only. This source does not establish today's drop pool,
 * investment returns, prices or stock on CSBoard.
 */
export const CS20_SOURCE = 'https://steamcommunity.com/market/listings/730/G18BD243004?count=100&start=0';
export const CS20_CONTENTS: Record<string, string> = {
  'Dual Berettas | Elite 1.6': 'Mil-Spec', 'Tec-9 | Flash Out': 'Mil-Spec',
  'MAC-10 | Classic Crate': 'Mil-Spec', 'MAG-7 | Popdog': 'Mil-Spec',
  'SCAR-20 | Assault': 'Mil-Spec', 'FAMAS | Decommissioned': 'Mil-Spec',
  'Glock-18 | Sacrifice': 'Mil-Spec', 'M249 | Aztec': 'Restricted',
  'MP5-SD | Agent': 'Restricted', 'Five-SeveN | Buddy': 'Restricted',
  'P250 | Inferno': 'Restricted', 'UMP-45 | Plastique': 'Restricted',
  'MP9 | Hydra': 'Classified', 'P90 | Nostalgia': 'Classified',
  'AUG | Death by Puppy': 'Classified', 'AWP | Wildfire': 'Covert',
  'FAMAS | Commemoration': 'Covert',
};
export const CASE_CONTENT_FACTS = `Case-content tables must come from a verified container list, never model memory. Do not infer current drop-pool status or guarantee item availability.
Reviewed CS20 Case contents (Valve, checked2026-11-01): ${JSON.stringify(CS20_CONTENTS)}.
CS20 has the Classic Knife as its rare special item; the17 weapon finishes are not its only possible result. Source: ${CS20_SOURCE}.
For other cases, do not invent a complete contents/rarity table without supplied verified container data.`;

interface Draft { title?: string | null; body_html: string; body_md?: string | null; body_blocks?: unknown; faq?: unknown; }
const plain = (s: unknown) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const rarity = /\b(Mil-Spec|Restricted|Classified|Covert)\b/i;
export function caseContentsIssues(draft: Draft): string[] {
  // Related-link selection has only a title, not the article being published.
  if (!draft.body_html && !draft.body_md && !draft.body_blocks && !draft.faq) return [];
  const title = draft.title ?? '';
  const fullGuide = /\bcase\b|кейс/i.test(title) && !/case hardened/i.test(title) && /contents|all skins|rarity|содержим|все скины|редкост/i.test(title);
  const cs20 = /\bcs20\b/i.test(title);
  if (fullGuide && !cs20) return ['Case contents require a reviewed container dataset before publication; no verified dataset for this case'];
  if (!cs20) return [];
  const issues = new Set<string>();
  let blocks = draft.body_blocks;
  if (typeof blocks === 'string') { try { blocks = JSON.parse(blocks); } catch { /* schema gate handles invalid JSON */ } }
  const tableRows: unknown[][] = [];
  const itemRows: unknown[][] = [];
  if (Array.isArray(blocks)) for (const b of blocks) {
    if (b?.type === 'table' && Array.isArray(b.rows)) tableRows.push(...b.rows.filter(Array.isArray));
    if (b?.type === 'item_grid' && Array.isArray(b.items)) for (const i of b.items) itemRows.push([i.name, i.stat]);
  }
  for (const table of draft.body_html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    for (const row of table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      tableRows.push([...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(x => plain(x[1])));
    }
  }
  const seen = new Set<string>();
  for (const [rows, isTable] of [[tableRows, true], [itemRows, false]] as const) for (const row of rows) {
    const cells = row.map(plain);
    const name = cells.find(s => s.includes(' | '));
    if (!name) continue;
    const expected = CS20_CONTENTS[name];
    if (!expected) { issues.add(`CS20 container mismatch: ${name}`); continue; }
    if (isTable) seen.add(name);
    const stated = cells.join(' ').match(rarity)?.[1];
    if (stated && stated.toLowerCase() !== expected.toLowerCase()) issues.add(`CS20 rarity mismatch: ${name} must be ${expected}`);
  }
  if (fullGuide && seen.size !== 17) issues.add('Complete CS20 contents table must contain the17 verified weapon finishes');
  const all = plain([draft.body_html, draft.body_md, JSON.stringify(blocks), JSON.stringify(draft.faq)].join(' '));
  if (/cs20 case[^.!?]{0,80}(?:does not (?:include|contain)|contains no)[^.!?]{0,60}(?:kniv|special items)/i.test(all)) issues.add('CS20 has the Classic Knife as its rare special item');
  return [...issues];
}
