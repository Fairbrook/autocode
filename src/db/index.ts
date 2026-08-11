import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

export type Db = DatabaseSync;

export function openDb(dbPath: string): Db {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  return db;
}

function runMigrations(db: Db): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)"
  );
  const row = db.prepare("SELECT version FROM schema_version").get() as
    | { version: number }
    | undefined;
  let current = row?.version ?? 0;
  if (row === undefined) {
    db.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
  }

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const num = Number.parseInt(file.split("_")[0] ?? "", 10);
    if (!Number.isFinite(num) || num <= current) continue;
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("UPDATE schema_version SET version = ?").run(num);
      db.exec("COMMIT");
      current = num;
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`, {
        cause: err,
      });
    }
  }
}

/** ISO-8601 timestamp helper — the harness's single source of "now" so tests can stub it. */
export function nowIso(): string {
  return new Date().toISOString();
}
