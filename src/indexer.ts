import { spaceCjk } from "./search.ts";
import { createHash } from "node:crypto";
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";
import type { Db } from "./db.ts";
import { transaction } from "./db.ts";
import type { Embedder } from "./embed.ts";
import { toBlob } from "./embed.ts";
import { parseNote } from "./parse.ts";

export interface IndexStats {
  scanned: number;
  added: number;
  updated: number;
  removed: number;
  /** Files that could not be read, or are larger than MAX_NOTE_BYTES. */
  skipped: number;
}

const SKIP_DIRS = new Set(["node_modules"]);
/** Larger files are almost always pasted binary data, not notes. */
export const MAX_NOTE_BYTES = 5 * 1024 * 1024;

/** All .md files under dir as vault-relative POSIX paths. Dot-directories (.obsidian, .git, .trash) are skipped. */
export function listNotes(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      // A subfolder we may not read (permissions, a sync client) must not take the whole vault down. The root failing still throws.
      if (current === dir) throw error;
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        out.push(relative(dir, full).split(sep).join("/"));
      }
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Maps a link target or a user-supplied name to a note id, the way Obsidian does:
 * exact path first, then file name, then alias, then title (all case-insensitive).
 * Given the linking note's path, a target relative to that note's folder wins over everything else.
 */
export function buildResolver(db: Db): (name: string, from?: string) => number | undefined {
  const byPath = new Map<string, number>();
  const byName = new Map<string, number>();
  const byAlias = new Map<string, number>();
  const rows = db.prepare("SELECT id, path, title, aliases FROM notes ORDER BY path").all() as {
    id: number;
    path: string;
    title: string;
    aliases: string;
  }[];
  // macOS names files with combining accents; people type precomposed ones. Compare both as NFC.
  const fold = (text: string) => text.normalize("NFC").toLowerCase();
  const put = (map: Map<string, number>, key: string, id: number) => {
    if (!map.has(key)) map.set(key, id);
  };
  for (const row of rows) {
    const noExt = fold(row.path.replace(/\.md$/i, ""));
    put(byPath, noExt, row.id);
    put(byName, noExt.split("/").pop()!, row.id);
    for (const alias of JSON.parse(row.aliases) as string[]) put(byAlias, fold(alias), row.id);
  }
  for (const row of rows) put(byAlias, fold(row.title), row.id);
  return (name, from) => {
    const key = fold(name.trim().replace(/\.md$/i, "").replace(/^\.?\//, ""));
    const sibling = from === undefined ? undefined : byPath.get(posix.join(posix.dirname(fold(from)), key));
    return sibling ?? byPath.get(key) ?? byName.get(key.split("/").pop()!) ?? byAlias.get(key);
  };
}

function deleteNote(db: Db, id: number): void {
  db.prepare("DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE note_id = ?)").run(id);
  db.prepare("DELETE FROM notes WHERE id = ?").run(id); // chunks, tags and links cascade
}

/** Brings the keyword index in line with the files on disk. Only new or changed files are re-read. */
export function indexVault(db: Db, dir: string): IndexStats {
  const stats: IndexStats = { scanned: 0, added: 0, updated: 0, removed: 0, skipped: 0 };
  const insertNote = db.prepare("INSERT INTO notes(path, title, mtime, size, hash, aliases, frontmatter, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const insertChunk = db.prepare("INSERT INTO chunks(note_id, heading, text, line) VALUES (?, ?, ?, ?)");
  const insertFts = db.prepare("INSERT INTO chunks_fts(rowid, title, heading, text, tags) VALUES (?, ?, ?, ?, ?)");
  const insertTag = db.prepare("INSERT INTO tags(note_id, tag) VALUES (?, ?)");
  const insertLink = db.prepare("INSERT OR IGNORE INTO links(src, target) VALUES (?, ?)");

  const files = listNotes(dir);
  transaction(db, () => {
    // Read the current state inside the write transaction: another process may have indexed in the meantime.
    const known = new Map(
      (db.prepare("SELECT id, path, mtime, size, hash FROM notes").all() as { id: number; path: string; mtime: number; size: number; hash: string }[]).map(
        (row) => [row.path, row],
      ),
    );
    for (const path of files) {
      stats.scanned++;
      const full = join(dir, path);
      const old = known.get(path);
      known.delete(path);
      let stat: ReturnType<typeof statSync>;
      let raw: string;
      try {
        stat = statSync(full);
        if (stat.size > MAX_NOTE_BYTES) throw new Error("too large");
        if (old && old.mtime === Math.round(stat.mtimeMs) && old.size === stat.size) continue;
        raw = readFileSync(full, "utf8");
      } catch {
        // One unreadable file must not stop the rest of the vault from being indexed.
        stats.skipped++;
        continue;
      }
      const mtime = Math.round(stat.mtimeMs);
      const hash = createHash("sha1").update(raw).digest("hex");
      if (old && old.hash === hash) {
        db.prepare("UPDATE notes SET mtime = ?, size = ? WHERE id = ?").run(mtime, stat.size, old.id);
        continue;
      }
      if (old) deleteNote(db, old.id);
      const note = parseNote(path, raw);
      const noteId = Number(
        insertNote.run(path, note.title, mtime, stat.size, hash, JSON.stringify(note.aliases), JSON.stringify(note.frontmatter), note.body).lastInsertRowid,
      );
      for (const chunk of note.chunks) {
        const chunkId = insertChunk.run(noteId, chunk.heading, chunk.text, chunk.line).lastInsertRowid;
        // Aliases are other names for the title, so they are searched with the title's weight.
        insertFts.run(chunkId, spaceCjk([note.title, ...note.aliases].join("\n")), spaceCjk(chunk.heading), spaceCjk(chunk.text), note.tags.join(" "));
      }
      for (const tag of note.tags) insertTag.run(noteId, tag);
      for (const target of note.links) insertLink.run(noteId, target);
      if (old) stats.updated++;
      else stats.added++;
    }
    for (const gone of known.values()) {
      deleteNote(db, gone.id);
      stats.removed++;
    }
    if (stats.added || stats.updated || stats.removed) {
      // A new note can satisfy an old dangling link, so resolve everything again. Cheap at vault scale.
      const resolve = buildResolver(db);
      const setDst = db.prepare("UPDATE links SET dst = ? WHERE src = ? AND target = ?");
      const links = db.prepare("SELECT l.src, l.target, n.path FROM links l JOIN notes n ON n.id = l.src").all() as { src: number; target: string; path: string }[];
      for (const link of links) setDst.run(resolve(link.target, link.path) ?? null, link.src, link.target);
    }
  });
  return stats;
}

/** Embeds every chunk that has no vector yet. Returns how many were embedded. */
export async function embedPending(db: Db, embedder: Embedder, onProgress?: (done: number, total: number) => void): Promise<number> {
  const stored = db.prepare("SELECT value FROM meta WHERE key = 'embed_model'").get() as { value: string } | undefined;
  if (stored?.value !== embedder.id) {
    db.exec("UPDATE chunks SET embedding = NULL");
    db.prepare("INSERT INTO meta(key, value) VALUES ('embed_model', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(embedder.id);
  }
  const pending = db
    .prepare("SELECT c.id, n.title, c.heading, c.text FROM chunks c JOIN notes n ON n.id = c.note_id WHERE c.embedding IS NULL")
    .all() as { id: number; title: string; heading: string; text: string }[];
  const update = db.prepare("UPDATE chunks SET embedding = ? WHERE id = ?");
  const model = db.prepare("SELECT value FROM meta WHERE key = 'embed_model'");
  const BATCH = 16;
  let done = 0;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    // Title and heading give short chunks the context they need to embed well.
    const vectors = await embedder.embed(batch.map((c) => `${c.title}\n${c.heading}\n${c.text}`));
    const written = transaction(db, () => {
      // Another process switched the index to a different model while we were computing: do not mix vectors.
      if ((model.get() as { value: string } | undefined)?.value !== embedder.id) return false;
      batch.forEach((c, j) => update.run(toBlob(vectors[j]), c.id)); // a chunk deleted meanwhile is simply not updated
      return true;
    });
    if (!written) break;
    done += batch.length;
    onProgress?.(done, pending.length);
  }
  return done;
}
