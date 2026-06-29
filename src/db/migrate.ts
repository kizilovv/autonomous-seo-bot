import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, closeDb } from "./connection.js";
import { logger } from "../logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// migrations live at PROJECT_ROOT/migrations. We try several candidates so the
// resolver works whether running from `tsx src/...` (cwd=project) or compiled
// `node dist/src/...` (cwd=project, __dirname inside dist).
function resolveMigrationsDir(): string {
  const candidates = [
    path.resolve(process.cwd(), "migrations"),         // pm2 cwd
    path.resolve(__dirname, "../../../migrations"),    // dist/src/db -> project root
    path.resolve(__dirname, "../../migrations"),       // src/db -> project root (tsx run)
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0]; // best guess; downstream warn handles missing dir
}
const MIGRATIONS_DIR = resolveMigrationsDir();

interface MigrationRow {
  filename: string;
}

export function runMigrations(): void {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    filename TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );`);

  const applied = new Set(
    (db.prepare("SELECT filename FROM _migrations").all() as MigrationRow[]).map((r) => r.filename)
  );

  const files = fs.existsSync(MIGRATIONS_DIR)
    ? fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()
    : [];

  if (!files.length) {
    logger.warn({ dir: MIGRATIONS_DIR }, "no migration files found");
    return;
  }

  const insert = db.prepare("INSERT INTO _migrations (filename) VALUES (?)");
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    logger.info({ file }, "applying migration");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      insert.run(file);
      db.exec("COMMIT");
      logger.info({ file }, "migration applied");
    } catch (e) {
      db.exec("ROLLBACK");
      logger.error({ file, error: (e as Error).message }, "migration failed");
      throw e;
    }
  }
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    runMigrations();
    closeDb();
    process.exit(0);
  } catch (e) {
    logger.error({ error: (e as Error).message }, "migration script failed");
    process.exit(1);
  }
}
