import type Database from 'better-sqlite3';
import type { RankedKeywordItem } from './client.js';
export interface PullCheckpoint { capturedAt?: number; own?: RankedKeywordItem[]; competitor?: RankedKeywordItem[] }
const MAX_AGE = 6 * 60 * 60 * 1000;
function validItems(value: unknown): value is RankedKeywordItem[] {
  return Array.isArray(value) && value.length <= 500 && value.every(item => item && typeof item.keyword === 'string' &&
    ['search_volume','cpc','difficulty','position'].every(key => item[key] === null || (typeof item[key] === 'number' && Number.isFinite(item[key]))) &&
    (item.url === null || typeof item.url === 'string'));
}
export function loadCheckpoint(db: Database.Database, key: string, now = Date.now()): PullCheckpoint {
  const rows = db.prepare("SELECT stats FROM runs WHERE worker='dataforseo_pull' AND status='failed' AND stats IS NOT NULL ORDER BY id DESC LIMIT 10").all() as Array<{stats:string}>;
  for (const row of rows) {
    try {
      const saved = JSON.parse(row.stats)?.dataforseo_checkpoint;
      if (!saved || saved.key !== key || typeof saved.at !== 'number' || !Number.isFinite(saved.at) || now < saved.at || now-saved.at > MAX_AGE) continue;
      if (saved.own !== undefined && !validItems(saved.own)) continue;
      if (saved.competitor !== undefined && !validItems(saved.competitor)) continue;
      return { capturedAt: saved.at, ...(saved.own !== undefined && {own:saved.own}), ...(saved.competitor !== undefined && {competitor:saved.competitor}) };
    } catch { /* Ignore unrelated/legacy/malformed run stats. */ }
  }
  return {};
}
export function saveCheckpoint(db: Database.Database, runId: number, key: string, stages: PullCheckpoint, now = Date.now()): void {
  db.prepare('UPDATE runs SET stats=? WHERE id=? AND status=\'running\'').run(JSON.stringify({dataforseo_checkpoint:{key,at:stages.capturedAt ?? now,...stages}}),runId);
}
