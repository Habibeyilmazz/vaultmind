import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes(
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL,
  hash TEXT NOT NULL,
  aliases TEXT NOT NULL,
  frontmatter TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks(
  id INTEGER PRIMARY KEY,
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  heading TEXT NOT NULL,
  text TEXT NOT NULL,
  line INTEGER NOT NULL,
  embedding BLOB
);
CREATE INDEX IF NOT EXISTS chunks_note ON chunks(note_id);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  title, heading, text, tags, tokenize='porter unicode61 remove_diacritics 2'
);
CREATE TABLE IF NOT EXISTS tags(
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY(note_id, tag)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS links(
  src INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  target TEXT NOT NULL,
  dst INTEGER REFERENCES notes(id) ON DELETE SET NULL,
  PRIMARY KEY(src, target)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
`;

export function openDb(file: string): Db {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // WAL lets the web UI, the MCP server and the CLI use the same index at once.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
