import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

/** Bump when the schema changes. The index is a cache: a version mismatch drops and rebuilds it. */
const SCHEMA_VERSION = 3;
/** Marks the file as a vaultmind index ("vmnd"). Indexes made before it existed are recognised by their chunks_fts table. */
const APPLICATION_ID = 0x766d6e64;

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
  -- AUTOINCREMENT: ids are never reused, so a vector computed for a deleted chunk can never land on a new one.
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  // WAL lets the web UI, the MCP server and the CLI use the same index at once. Switching to it needs a lock that
  // SQLite's busy timeout does not wait for, so processes opening a new index together must retry by hand.
  for (let attempt = 0; ; attempt++) {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      break;
    } catch (error) {
      if (attempt >= 100 || (error as { errcode?: number }).errcode !== 5) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  const current = () => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (current() !== SCHEMA_VERSION) {
    // Check again inside the write lock: a process that got there first has already built the schema.
    transaction(db, () => {
      if (current() === SCHEMA_VERSION) return;
      // --db can name any file: never drop the tables of a database some other program owns.
      const appId = (db.prepare("PRAGMA application_id").get() as { application_id: number }).application_id;
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
      if (appId !== APPLICATION_ID && tables.length && !tables.some((t) => t.name === "chunks_fts")) {
        throw new Error(`${file} is a database that vaultmind did not create; refusing to overwrite it. Choose another --db file.`);
      }
      db.exec("DROP TABLE IF EXISTS links; DROP TABLE IF EXISTS tags; DROP TABLE IF EXISTS chunks_fts; DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS notes; DROP TABLE IF EXISTS meta;");
      db.exec(`${SCHEMA} PRAGMA user_version = ${SCHEMA_VERSION}; PRAGMA application_id = ${APPLICATION_ID};`);
    });
  }
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
