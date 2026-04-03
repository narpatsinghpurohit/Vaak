import Database from "better-sqlite3";
import { join } from "path";
import { getAppDir } from "./settings";
import type { HistoryEntry } from "./types";

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    const dbPath = join(getAppDir(), "history.db");
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        provider TEXT NOT NULL,
        language TEXT NOT NULL DEFAULT 'en',
        duration_secs REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        pinned INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_history_created_at ON history(created_at DESC)",
    );
  }
  return db;
}

export function insertHistory(
  text: string,
  provider: string,
  language: string,
  durationSecs: number,
): number {
  const result = getDb().prepare(
    "INSERT INTO history (text, provider, language, duration_secs) VALUES (?, ?, ?, ?)",
  ).run(text, provider, language, durationSecs);
  return Number(result.lastInsertRowid);
}

export function queryHistory(
  search?: string,
  limit = 50,
  offset = 0,
): HistoryEntry[] {
  const d = getDb();
  if (search && search.trim()) {
    return d
      .prepare(
        "SELECT * FROM history WHERE text LIKE ? ORDER BY pinned DESC, created_at DESC LIMIT ? OFFSET ?",
      )
      .all(`%${search}%`, limit, offset) as HistoryEntry[];
  }
  return d
    .prepare(
      "SELECT * FROM history ORDER BY pinned DESC, created_at DESC LIMIT ? OFFSET ?",
    )
    .all(limit, offset) as HistoryEntry[];
}

export function deleteHistoryEntry(id: number): void {
  getDb().prepare("DELETE FROM history WHERE id = ?").run(id);
}

export function clearHistory(): void {
  getDb().prepare("DELETE FROM history").run();
}

export function togglePin(id: number): void {
  getDb()
    .prepare(
      "UPDATE history SET pinned = CASE WHEN pinned = 0 THEN 1 ELSE 0 END WHERE id = ?",
    )
    .run(id);
}

export function getHistoryEntryText(id: number): string | null {
  const row = getDb()
    .prepare("SELECT text FROM history WHERE id = ?")
    .get(id) as { text: string } | null;
  return row?.text ?? null;
}
