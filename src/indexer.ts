import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
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
}

const SKIP_DIRS = new Set(["node_modules"]);

/** All .md files under dir as vault-relative POSIX paths. Dot-directories (.obsidian, .git, .trash) are skipped. */
export function listNotes(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
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
 */
export function buildResolver(db: Db): (name: string) => number | undefined {
  const byPath = new Map<string, number>();
  const byName = new Map<string, number>();
  const byAlias = new Map<string, number>();
  const rows = db.prepare("SELECT id, path, title, aliases FROM notes ORDER BY path").all() as {
    id: number;
    path: string;
    title: string;
    aliases: string;
  }[];
  const put = (map: Map<string, number>, key: string, id: number) => {
    if (!map.has(key)) map.set(key, id);
  };
  for (const row of rows) {
    const noExt = row.path.replace(/\.md$/i, "").toLowerCase();
    put(byPath, noExt, row.id);
    put(byName, noExt.split("/").pop()!, row.id);
    for (const alias of JSON.parse(row.aliases) as string[]) put(byAlias, alias.toLowerCase(), row.id);
  }
  for (const row of rows) put(byAlias, row.title.toLowerCase(), row.id);
  return (name) => {
    const key = name.trim().replace(/\.md$/i, "").replace(/^\.?\//, "").toLowerCase();
    return byPath.get(key) ?? byName.get(key.split("/").pop()!) ?? byAlias.get(key);
  };
}

function deleteNote(db: Db, id: number): void {
  db.prepare("DELETE FROM chunks_fts WHERE rowid IN (SELECT id FROM chunks WHERE note_id = ?)").run(id);
  db.prepare("DELETE FROM notes WHERE id = ?").run(id); // chunks, tags and links cascade
}

/** Brings the keyword index in line with the files on disk. Only new or changed files are re-read. */
export function indexVault(db: Db, dir: string): IndexStats {
  const stats: IndexStats = { scanned: 0, added: 0, updated: 0, removed: 0 };
  const known = new Map(
    (db.prepare("SELECT id, path, mtime, size, hash FROM notes").all() as { id: number; path: string; mtime: number; size: number; hash: string }[]).map(
      (row) => [row.path, row],
    ),
  );
  const insertNote = db.prepare("INSERT INTO notes(path, title, mtime, size, hash, aliases, frontmatter, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const insertChunk = db.prepare("INSERT INTO chunks(note_id, heading, text, line) VALUES (?, ?, ?, ?)");
  const insertFts = db.prepare("INSERT INTO chunks_fts(rowid, title, heading, text, tags) VALUES (?, ?, ?, ?, ?)");
  const insertTag = db.prepare("INSERT INTO tags(note_id, tag) VALUES (?, ?)");
  const insertLink = db.prepare("INSERT OR IGNORE INTO links(src, target) VALUES (?, ?)");

  transaction(db, () => {
    for (const path of listNotes(dir)) {
      stats.scanned++;
      const full = join(dir, path);
      const stat = statSync(full);
      const mtime = Math.round(stat.mtimeMs);
      const old = known.get(path);
      known.delete(path);
      if (old && old.mtime === mtime && old.size === stat.size) continue;
      const raw = readFileSync(full, "utf8");
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
        insertFts.run(chunkId, note.title, chunk.heading, chunk.text, note.tags.join(" "));
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
      for (const link of db.prepare("SELECT src, target FROM links").all() as { src: number; target: string }[]) {
        setDst.run(resolve(link.target) ?? null, link.src, link.target);
      }
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
  const BATCH = 16;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    // Title and heading give short chunks the context they need to embed well.
    const vectors = await embedder.embed(batch.map((c) => `${c.title}\n${c.heading}\n${c.text}`));
    transaction(db, () => batch.forEach((c, j) => update.run(toBlob(vectors[j]), c.id)));
    onProgress?.(Math.min(i + BATCH, pending.length), pending.length);
  }
  return pending.length;
}
