import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const dir = path.dirname(config.DB_PATH);
  fs.mkdirSync(dir, { recursive: true });
  db = new Database(config.DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  logger.info({ path: config.DB_PATH }, "sqlite connected");
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// Helper: run a closure inside a transaction.
export function tx<T>(fn: (db: Database.Database) => T): T {
  const d = getDb();
  const wrapped = d.transaction(fn);
  return wrapped(d);
}
