import type { Db } from "./db.ts";
import type { Embedder } from "./embed.ts";
import { dot, fromBlob } from "./embed.ts";
import { buildResolver } from "./indexer.ts";

export type SearchMode = "auto" | "keyword" | "semantic";

export interface Hit {
  path: string;
  title: string;
  /** Heading path of the best matching section. */
  heading: string;
  line: number;
  /** Excerpt of the best matching section; keyword matches are wrapped in HL_START/HL_END. */
  snippet: string;
  /** Full text of the best matching section. */
  text: string;
  tags: string[];
  score: number;
}

export interface SearchResult {
  /** What actually ran: "hybrid" needs embeddings, otherwise "keyword". */
  mode: "hybrid" | "keyword" | "semantic";
  total: number;
  hits: Hit[];
}

export const HL_START = "\u0001";
export const HL_END = "\u0002";

/** Semantic candidates below this cosine similarity are noise for small sentence-embedding models. */
const MIN_SIMILARITY = 0.25;
const CANDIDATES = 100;
const RRF_K = 60;

interface Candidate {
  chunkId: number;
  snippet?: string;
}

// Questions like "how do I keep my starter alive" would otherwise be ranked by their filler words. English only.
const STOPWORDS = new Set(
  "a an and are as at be been by can could did do does for from how i if in is it its me my of on or should that the there this to was we were what when where which who why will with would you your".split(
    " ",
  ),
);

/** Turns free text into an FTS5 query: quoted terms joined by OR, so input can never be read as FTS syntax. */
export function ftsQuery(text: string, prefix = false): string {
  const words = text.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const content = words.filter((word) => !STOPWORDS.has(word.toLowerCase()));
  const terms = content.length ? content : words;
  return terms.map((term, i) => `"${term}"${prefix && i === terms.length - 1 ? "*" : ""}`).join(" OR ");
}

function keywordCandidates(db: Db, query: string, prefix: boolean): Candidate[] {
  const match = ftsQuery(query, prefix);
  if (!match) return [];
  // bm25 weights: title, heading, text, tags.
  const rows = db
    .prepare(
      `SELECT rowid AS chunkId, snippet(chunks_fts, 2, char(1), char(2), '…', 28) AS snippet
       FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts, 4.0, 2.0, 1.0, 2.0) LIMIT ?`,
    )
    .all(match, CANDIDATES) as { chunkId: number; snippet: string }[];
  return rows;
}

// shortcut: brute-force scan over every stored vector per query; fine up to roughly 50k chunks, then add a vector index.
function allVectors(db: Db): { chunkId: number; noteId: number; vector: Float32Array }[] {
  const rows = db.prepare("SELECT id, note_id, embedding FROM chunks WHERE embedding IS NOT NULL").all() as {
    id: number;
    note_id: number;
    embedding: Uint8Array;
  }[];
  return rows.map((row) => ({ chunkId: row.id, noteId: row.note_id, vector: fromBlob(row.embedding) }));
}

async function semanticCandidates(db: Db, query: string, embedder: Embedder): Promise<Candidate[]> {
  const [queryVector] = await embedder.embed([query]);
  return allVectors(db)
    .filter((row) => row.vector.length === queryVector.length)
    .map((row) => ({ chunkId: row.chunkId, score: dot(queryVector, row.vector) }))
    .filter((row) => row.score >= MIN_SIMILARITY)
    .sort((a, b) => b.score - a.score)
    .slice(0, CANDIDATES);
}

export function hasEmbeddings(db: Db): boolean {
  return db.prepare("SELECT 1 FROM chunks WHERE embedding IS NOT NULL LIMIT 1").get() !== undefined;
}

export function tagsOf(db: Db, noteId: number): string[] {
  return (db.prepare("SELECT tag FROM tags WHERE note_id = ? ORDER BY tag").all(noteId) as { tag: string }[]).map((row) => row.tag);
}

export interface SearchOptions {
  mode?: SearchMode;
  limit?: number;
  offset?: number;
  /** Treat the last word as a prefix (search-as-you-type). */
  prefix?: boolean;
  embedder?: Embedder | null;
}

/**
 * Ranks sections, then returns the best section per note.
 * "auto" fuses BM25 and vector rankings with reciprocal rank fusion when embeddings exist, and is plain BM25 otherwise.
 */
export async function search(db: Db, query: string, options: SearchOptions = {}): Promise<SearchResult> {
  const { mode = "auto", limit = 10, offset = 0, prefix = false, embedder } = options;
  const semanticReady = Boolean(embedder) && hasEmbeddings(db);
  if (mode === "semantic" && !semanticReady) {
    throw new Error("Semantic search is unavailable: the index has no embeddings. Run `vaultmind index` without --no-embed, or use keyword mode.");
  }
  const used: SearchResult["mode"] = mode === "semantic" ? "semantic" : mode === "auto" && semanticReady ? "hybrid" : "keyword";
  const lists: Candidate[][] = [];
  if (used !== "semantic") lists.push(keywordCandidates(db, query, prefix));
  if (used !== "keyword") lists.push(await semanticCandidates(db, query, embedder!));

  const fused = new Map<number, { score: number; snippet?: string }>();
  for (const list of lists) {
    list.forEach((candidate, rank) => {
      const entry = fused.get(candidate.chunkId) ?? { score: 0 };
      entry.score += 1 / (RRF_K + rank + 1);
      entry.snippet ??= candidate.snippet;
      fused.set(candidate.chunkId, entry);
    });
  }
  const ranked = [...fused.entries()].sort((a, b) => b[1].score - a[1].score);

  const chunkRow = db.prepare(
    "SELECT c.note_id AS noteId, c.heading, c.text, c.line, n.path, n.title FROM chunks c JOIN notes n ON n.id = c.note_id WHERE c.id = ?",
  );
  const seen = new Set<number>();
  const hits: Hit[] = [];
  for (const [chunkId, entry] of ranked) {
    const row = chunkRow.get(chunkId) as { noteId: number; heading: string; text: string; line: number; path: string; title: string } | undefined;
    if (!row || seen.has(row.noteId)) continue;
    seen.add(row.noteId);
    hits.push({
      path: row.path,
      title: row.title,
      heading: row.heading,
      line: row.line,
      snippet: entry.snippet ?? (row.text.length > 220 ? `${row.text.slice(0, 220)}…` : row.text),
      text: row.text,
      tags: tagsOf(db, row.noteId),
      score: entry.score,
    });
  }
  return { mode: used, total: hits.length, hits: hits.slice(offset, offset + limit) };
}

export interface NoteRef {
  path: string;
  title: string;
}

export interface Note extends NoteRef {
  body: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
  /** Epoch milliseconds of the file's last modification. */
  modified: number;
  links: NoteRef[];
  /** Link targets that match no note in the vault. */
  unresolved: string[];
  backlinks: NoteRef[];
}

interface NoteRow {
  id: number;
  path: string;
  title: string;
  mtime: number;
  frontmatter: string;
  body: string;
}

function noteRow(db: Db, name: string): NoteRow | undefined {
  const byPath = db.prepare("SELECT id, path, title, mtime, frontmatter, body FROM notes WHERE path = ?");
  const exact = byPath.get(name) as NoteRow | undefined;
  if (exact) return exact;
  const id = buildResolver(db)(name);
  return id === undefined ? undefined : (db.prepare("SELECT id, path, title, mtime, frontmatter, body FROM notes WHERE id = ?").get(id) as unknown as NoteRow);
}

/** Looks a note up by vault-relative path, file name, alias or title. Reads only from the index, never from disk. */
export function getNote(db: Db, name: string): Note | undefined {
  const row = noteRow(db, name);
  if (!row) return undefined;
  const out = db
    .prepare("SELECT l.target, n.path, n.title FROM links l LEFT JOIN notes n ON n.id = l.dst WHERE l.src = ? ORDER BY l.target")
    .all(row.id) as { target: string; path: string | null; title: string | null }[];
  const links = new Map<string, NoteRef>();
  for (const link of out) if (link.path) links.set(link.path, { path: link.path, title: link.title! });
  return {
    path: row.path,
    title: row.title,
    body: row.body,
    frontmatter: JSON.parse(row.frontmatter) as Record<string, unknown>,
    tags: tagsOf(db, row.id),
    modified: row.mtime,
    links: [...links.values()],
    unresolved: out.filter((link) => !link.path).map((link) => link.target),
    backlinks: db
      .prepare("SELECT DISTINCT n.path, n.title FROM links l JOIN notes n ON n.id = l.src WHERE l.dst = ? AND l.src != ? ORDER BY n.path")
      .all(row.id, row.id) as unknown as NoteRef[],
  };
}

export interface Related extends NoteRef {
  score: number;
  /** Human-readable reasons, e.g. "links to this note", "shares #baking". */
  reasons: string[];
}

/** Notes connected to the given one by links, shared tags, and similar content (vectors if present, else title keywords). */
export async function relatedNotes(db: Db, name: string, limit = 8): Promise<Related[] | undefined> {
  const self = noteRow(db, name);
  if (!self) return undefined;
  const found = new Map<number, { score: number; reasons: string[] }>();
  const add = (id: number, score: number, reason: string) => {
    if (id === self.id) return;
    const entry = found.get(id) ?? { score: 0, reasons: [] };
    entry.score += score;
    entry.reasons.push(reason);
    found.set(id, entry);
  };

  for (const row of db.prepare("SELECT DISTINCT dst FROM links WHERE src = ? AND dst IS NOT NULL").all(self.id) as { dst: number }[]) {
    add(row.dst, 1, "linked from this note");
  }
  for (const row of db.prepare("SELECT DISTINCT src FROM links WHERE dst = ?").all(self.id) as { src: number }[]) {
    add(row.src, 1, "links to this note");
  }
  const shared = db
    .prepare(
      `SELECT t.note_id AS id, group_concat('#' || t.tag, ', ') AS tags, count(*) AS n
       FROM tags t JOIN tags mine ON mine.tag = t.tag AND mine.note_id = ? WHERE t.note_id != ? GROUP BY t.note_id`,
    )
    .all(self.id, self.id) as { id: number; tags: string; n: number }[];
  for (const row of shared) add(row.id, Math.min(0.3 * row.n, 0.9), `shares ${row.tags}`);

  // Content similarity: compare the mean vector of each note's sections.
  const means = new Map<number, Float32Array>();
  const counts = new Map<number, number>();
  for (const row of allVectors(db)) {
    const mean = means.get(row.noteId);
    if (!mean) means.set(row.noteId, Float32Array.from(row.vector));
    else if (mean.length === row.vector.length) for (let i = 0; i < mean.length; i++) mean[i] += row.vector[i];
    counts.set(row.noteId, (counts.get(row.noteId) ?? 0) + 1);
  }
  const unit = (vector: Float32Array) => {
    const norm = Math.sqrt(dot(vector, vector)) || 1;
    return vector.map((x) => x / norm);
  };
  const mine = means.get(self.id);
  if (mine) {
    const selfUnit = unit(mine);
    for (const [id, mean] of means) {
      if (id === self.id || mean.length !== mine.length) continue;
      const similarity = dot(selfUnit, unit(mean));
      if (similarity >= 0.4) add(id, similarity, `similar content (${similarity.toFixed(2)})`);
    }
  } else {
    const similar = await search(db, self.title, { mode: "keyword", limit: 6 });
    similar.hits.forEach((hit, rank) => {
      const row = noteRow(db, hit.path);
      if (row) add(row.id, 0.5 / (rank + 1), "mentions this note's title words");
    });
  }

  const ref = db.prepare("SELECT path, title FROM notes WHERE id = ?");
  return [...found.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit)
    .map(([id, entry]) => ({ ...(ref.get(id) as unknown as NoteRef), score: Number(entry.score.toFixed(3)), reasons: entry.reasons }));
}

export interface RecentNote extends NoteRef {
  modified: number;
  tags: string[];
}

export function recentNotes(db: Db, limit = 10, offset = 0): { total: number; notes: RecentNote[] } {
  const total = (db.prepare("SELECT count(*) AS n FROM notes").get() as { n: number }).n;
  const rows = db.prepare("SELECT id, path, title, mtime FROM notes ORDER BY mtime DESC, path LIMIT ? OFFSET ?").all(limit, offset) as {
    id: number;
    path: string;
    title: string;
    mtime: number;
  }[];
  return { total, notes: rows.map((row) => ({ path: row.path, title: row.title, modified: row.mtime, tags: tagsOf(db, row.id) })) };
}

export interface Graph {
  nodes: { id: number; path: string; title: string; tags: string[] }[];
  edges: { source: number; target: number }[];
}

export function linkGraph(db: Db): Graph {
  const nodes = db.prepare("SELECT id, path, title FROM notes ORDER BY path").all() as { id: number; path: string; title: string }[];
  return {
    nodes: nodes.map((node) => ({ ...node, tags: tagsOf(db, node.id) })),
    edges: db.prepare("SELECT DISTINCT src AS source, dst AS target FROM links WHERE dst IS NOT NULL AND dst != src").all() as unknown as Graph["edges"],
  };
}

export function stats(db: Db): { notes: number; chunks: number; embedded: number; links: number; tags: number } {
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    notes: one("SELECT count(*) AS n FROM notes"),
    chunks: one("SELECT count(*) AS n FROM chunks"),
    embedded: one("SELECT count(*) AS n FROM chunks WHERE embedding IS NOT NULL"),
    links: one("SELECT count(*) AS n FROM links WHERE dst IS NOT NULL"),
    tags: one("SELECT count(DISTINCT tag) AS n FROM tags"),
  };
}
