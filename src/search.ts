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
  /** With a filter: how many notes pass it, whatever the query. */
  inScope?: number;
}

/** Limits a search or listing to notes with every one of these tags (nested tags count) inside this folder. */
export interface NoteFilter {
  tags?: string[];
  folder?: string;
}

const cleanTag = (tag: string) => tag.trim().replace(/^#/, "").toLowerCase();
const cleanFolder = (folder: string) =>
  folder
    .trim()
    .replaceAll("\\", "/")
    .replace(/^(\.?\/)+|\/+$/g, "")
    .toLowerCase();

/**
 * Splits Obsidian-style operators off a typed query: "tag:garden path:projects water" becomes
 * text "water", tags ["garden"], folder "projects". A quoted value may hold spaces: path:"my notes".
 */
export function parseQuery(query: string): { text: string; filter: NoteFilter } {
  const tags: string[] = [];
  let folder: string | undefined;
  const text = query.replace(/(?<=^|\s)(tag|path):(?:"([^"]*)"|(\S+))/gi, (_, key: string, quoted?: string, bare?: string) => {
    const value = quoted ?? bare ?? "";
    if (key.toLowerCase() === "tag") tags.push(value);
    else folder = value;
    return " ";
  });
  return { text: text.replace(/\s+/g, " ").trim(), filter: { tags, folder } };
}

/** Ids of the notes that pass the filter, or undefined when the filter is empty (every note passes). */
export function filterNotes(db: Db, filter: NoteFilter = {}): Set<number> | undefined {
  const tags = (filter.tags ?? []).map(cleanTag).filter(Boolean);
  const folder = cleanFolder(filter.folder ?? "");
  if (!tags.length && !folder) return undefined;
  // shortcut: filters in JS over every note (Unicode-aware lowercasing); fine for tens of thousands of notes.
  const rows = db
    .prepare("SELECT n.id, n.path, group_concat(t.tag, char(10)) AS tags FROM notes n LEFT JOIN tags t ON t.note_id = n.id GROUP BY n.id")
    .all() as { id: number; path: string; tags: string | null }[];
  const ids = new Set<number>();
  for (const row of rows) {
    if (folder && !row.path.toLowerCase().startsWith(`${folder}/`)) continue;
    const own = row.tags?.split("\n") ?? [];
    if (tags.every((tag) => own.some((mine) => mine === tag || mine.startsWith(`${tag}/`)))) ids.add(row.id);
  }
  return ids;
}

/** Every tag in the vault with its number of notes, most used first. */
export function allTags(db: Db): { tag: string; notes: number }[] {
  return db.prepare("SELECT tag, count(*) AS notes FROM tags GROUP BY tag ORDER BY notes DESC, tag").all() as { tag: string; notes: number }[];
}

export const HL_START = "\u0001";
export const HL_END = "\u0002";

/** Semantic candidates below this cosine similarity are noise for small sentence-embedding models. */
const MIN_SIMILARITY = 0.25;
const CANDIDATES = 100;
/** Sections one note may contribute to a ranking, so a long journal cannot push every other note out. */
const PER_NOTE = 3;
const RRF_K = 60;

/** One section in one ranking. */
interface Candidate {
  noteId: number;
  chunkId: number;
}

// Questions like "how do I keep my starter alive" would otherwise be ranked by their filler words. English only.
const STOPWORDS = new Set(
  "a an and are as at be been by can could did do does for from how i if in is it its me my of on or should that the there this to was we were what when where which who why will with would you your".split(
    " ",
  ),
);

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
/** Puts spaces around every Chinese or Japanese character so the FTS tokenizer indexes each one (it would keep a whole run as one word). */
export const spaceCjk = (text: string): string => text.replace(CJK, " $&");

/** Turns free text into an FTS5 query: quoted terms joined by OR, so input can never be read as FTS syntax. */
export function ftsQuery(text: string, prefix = false): string {
  const words = text.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const content = words.filter((word) => !STOPWORDS.has(word.toLowerCase()));
  const terms = content.length ? content : words;
  return terms.map((term, i) => `"${spaceCjk(term).trim()}"${prefix && i === terms.length - 1 ? "*" : ""}`).join(" OR ");
}

function keywordCandidates(db: Db, query: string, prefix: boolean, scope?: Set<number>): Candidate[] {
  const match = ftsQuery(query, prefix);
  if (!match) return [];
  // bm25 weights: title, heading, text, tags.
  return db
    .prepare(
      `WITH hits AS MATERIALIZED (
         SELECT chunks_fts.rowid AS chunkId, c.note_id AS noteId,
                bm25(chunks_fts, 4.0, 2.0, 1.0, 2.0) AS score
         FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
         WHERE chunks_fts MATCH ? AND (? IS NULL OR c.note_id IN (SELECT value FROM json_each(?)))),
       ranked AS (SELECT *, row_number() OVER (PARTITION BY noteId ORDER BY score) AS nth FROM hits)
       SELECT chunkId, noteId FROM ranked WHERE nth <= ? ORDER BY score LIMIT ?`,
    )
    .all(match, scope ? 1 : null, JSON.stringify(scope ? [...scope] : []), PER_NOTE, CANDIDATES) as unknown as Candidate[];
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

async function semanticCandidates(db: Db, query: string, embedder: Embedder, scope?: Set<number>): Promise<Candidate[]> {
  const [queryVector] = await embedder.embed([query]);
  const scored = allVectors(db)
    .filter((row) => row.vector.length === queryVector.length && (!scope || scope.has(row.noteId)))
    .map((row) => ({ noteId: row.noteId, chunkId: row.chunkId, score: dot(queryVector, row.vector) }))
    .filter((row) => row.score >= MIN_SIMILARITY)
    .sort((a, b) => b.score - a.score);
  const perNote = new Map<number, number>();
  const out: Candidate[] = [];
  for (const { noteId, chunkId } of scored) {
    const seen = perNote.get(noteId) ?? 0;
    if (seen >= PER_NOTE) continue;
    perNote.set(noteId, seen + 1);
    if (out.push({ noteId, chunkId }) === CANDIDATES) break;
  }
  return out;
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
  filter?: NoteFilter;
}

/**
 * Ranks sections, then returns the best section per note.
 * "auto" fuses BM25 and vector rankings with reciprocal rank fusion when embeddings exist, and is plain BM25 otherwise.
 * With a filter and no query words, lists the notes that pass the filter, newest first.
 */
export async function search(db: Db, query: string, options: SearchOptions = {}): Promise<SearchResult> {
  const { mode = "auto", limit = 10, offset = 0, prefix = false, embedder } = options;
  const scope = filterNotes(db, options.filter);
  const inScope = scope ? { inScope: scope.size } : {};
  if (scope && !/[\p{L}\p{N}]/u.test(query)) {
    const { total, notes } = recentNotes(db, limit, offset, options.filter);
    const firstChunk = db.prepare("SELECT c.heading, c.text, c.line FROM chunks c JOIN notes n ON n.id = c.note_id WHERE n.path = ? ORDER BY c.line, c.id LIMIT 1");
    const hits = notes.map((note) => {
      const chunk = (firstChunk.get(note.path) ?? { heading: "", text: "", line: 1 }) as { heading: string; text: string; line: number };
      return { path: note.path, title: note.title, ...chunk, snippet: excerpt(chunk.text), tags: note.tags, score: 0 };
    });
    return { mode: "keyword", total, hits, ...inScope };
  }
  const semanticReady = Boolean(embedder) && hasEmbeddings(db);
  if (mode === "semantic" && !semanticReady) {
    throw new Error(
      "Semantic search is unavailable right now: the embedding model is not loaded or the index has no embeddings yet. " +
        'Use mode "auto" or "keyword", or run `vaultmind index` without --no-embed.',
    );
  }
  const used: SearchResult["mode"] = mode === "semantic" ? "semantic" : mode === "auto" && semanticReady ? "hybrid" : "keyword";
  // Semantic first: when two sections tie after fusion, the one closer in meaning wins.
  const lists: Candidate[][] = [];
  if (used !== "keyword") lists.push(await semanticCandidates(db, query, embedder!, scope));
  if (used !== "semantic") lists.push(keywordCandidates(db, query, prefix, scope));

  // Reciprocal rank fusion over sections: a section both rankings like beats one that only one of them likes.
  const fused = new Map<number, Candidate & { score: number }>();
  for (const list of lists) {
    list.forEach((candidate, rank) => {
      const entry = fused.get(candidate.chunkId) ?? { ...candidate, score: 0 };
      entry.score += 1 / (RRF_K + rank + 1);
      fused.set(candidate.chunkId, entry);
    });
  }
  // Then one hit per note: its best section.
  const seen = new Set<number>();
  const ranked = [...fused.values()].sort((a, b) => b.score - a.score).filter((entry) => !seen.has(entry.noteId) && seen.add(entry.noteId));

  const chunkRow = db.prepare(
    "SELECT c.note_id AS noteId, c.heading, c.text, c.line, n.path, n.title FROM chunks c JOIN notes n ON n.id = c.note_id WHERE c.id = ?",
  );
  const match = ftsQuery(query, prefix);
  const snippetRow = match
    ? db.prepare("SELECT snippet(chunks_fts, 2, char(1), char(2), '…', 28) AS s FROM chunks_fts WHERE chunks_fts MATCH ? AND rowid = CAST(? AS INTEGER)")
    : undefined;
  const hits: Hit[] = [];
  for (const entry of ranked.slice(offset, offset + limit)) {
    const row = chunkRow.get(entry.chunkId) as { noteId: number; heading: string; text: string; line: number; path: string; title: string } | undefined;
    if (!row) continue;
    // snippet() costs ~7 ms a row on a 50k-section vault, so it runs for the returned page only, never for every match.
    // The CAST above matters: node:sqlite binds JS numbers as REAL, and FTS5 then drops the rowid filter and returns the first match.
    const snippet = used === "semantic" ? undefined : (snippetRow?.get(match, entry.chunkId) as { s: string } | undefined)?.s;
    hits.push({
      path: row.path,
      title: row.title,
      heading: row.heading,
      line: row.line,
      snippet: excerpt(row.text, snippet),
      text: row.text,
      tags: tagsOf(db, row.noteId),
      score: entry.score,
    });
  }
  return { mode: used, total: ranked.length, hits, ...inScope };
}

/** A short one-line excerpt: the FTS snippet when there is one, else the start of the section. */
function excerpt(text: string, snippet?: string): string {
  // Wikilink brackets and table rules are noise in a short excerpt; list items run together without a bullet.
  return (snippet?.replace(/(\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}) (?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u0002])/gu, "$1") ?? (text.length > 220 ? `${Array.from(text).slice(0, 220).join("")}…` : text))
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, "• ")
    .replace(/\[\[|\]\]/g, "")
    .replace(/\||-{3,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function noteRow(db: Db, name: string, from?: string): NoteRow | undefined {
  const byPath = db.prepare("SELECT id, path, title, mtime, frontmatter, body FROM notes WHERE path = ?");
  const exact = from === undefined ? (byPath.get(name) as NoteRow | undefined) : undefined;
  if (exact) return exact;
  const id = buildResolver(db)(name, from);
  return id === undefined ? undefined : (db.prepare("SELECT id, path, title, mtime, frontmatter, body FROM notes WHERE id = ?").get(id) as unknown as NoteRow);
}

/**
 * Looks a note up by vault-relative path, file name, alias or title. Reads only from the index, never from disk.
 * Pass `from` (the path of the note containing the link) to resolve a link target the way the indexer does.
 */
export function getNote(db: Db, name: string, from?: string): Note | undefined {
  const row = noteRow(db, name, from);
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

export function recentNotes(db: Db, limit = 10, offset = 0, filter?: NoteFilter): { total: number; notes: RecentNote[] } {
  const scope = filterNotes(db, filter);
  const where = "WHERE ? IS NULL OR id IN (SELECT value FROM json_each(?))";
  const args = [scope ? 1 : null, JSON.stringify(scope ? [...scope] : [])];
  const total = (db.prepare(`SELECT count(*) AS n FROM notes ${where}`).get(...args) as { n: number }).n;
  const rows = db.prepare(`SELECT id, path, title, mtime FROM notes ${where} ORDER BY mtime DESC, path LIMIT ? OFFSET ?`).all(...args, limit, offset) as {
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
  /** Notes per top-level folder ("" for the vault root), over the whole vault, so every graph colours folders alike. */
  folders: Record<string, number>;
}

const LINKS = "SELECT DISTINCT src AS source, dst AS target FROM links WHERE dst IS NOT NULL AND dst != src";

/** The whole link graph, or with `name` only that note, the notes it links with, and the links among them. */
export function linkGraph(db: Db): Graph;
export function linkGraph(db: Db, name?: string): Graph | undefined;
export function linkGraph(db: Db, name?: string): Graph | undefined {
  const folders = db
    .prepare("SELECT CASE WHEN instr(path, '/') > 0 THEN substr(path, 1, instr(path, '/') - 1) ELSE '' END AS folder, count(*) AS n FROM notes GROUP BY folder")
    .all() as { folder: string; n: number }[];
  let nodes: { id: number; path: string; title: string }[];
  let edges: Graph["edges"];
  if (name === undefined) {
    nodes = db.prepare("SELECT id, path, title FROM notes ORDER BY path").all() as typeof nodes;
    edges = db.prepare(LINKS).all() as unknown as Graph["edges"];
  } else {
    const self = noteRow(db, name);
    if (!self) return undefined;
    const near = `SELECT dst FROM links WHERE src = :id AND dst IS NOT NULL UNION SELECT src FROM links WHERE dst = :id UNION SELECT :id`;
    nodes = db.prepare(`SELECT id, path, title FROM notes WHERE id IN (${near}) ORDER BY path`).all({ id: self.id }) as typeof nodes;
    edges = db.prepare(`${LINKS} AND src IN (${near}) AND dst IN (${near})`).all({ id: self.id }) as unknown as Graph["edges"];
  }
  return {
    nodes: nodes.map((node) => ({ ...node, tags: tagsOf(db, node.id) })),
    edges,
    folders: Object.fromEntries(folders.map((row) => [row.folder, row.n])),
  };
}

export function stats(db: Db): { notes: number; chunks: number; embedded: number; links: number; tags: number } {
  const one = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    notes: one("SELECT count(*) AS n FROM notes"),
    chunks: one("SELECT count(*) AS n FROM chunks"),
    embedded: one("SELECT count(*) AS n FROM chunks WHERE embedding IS NOT NULL"),
    // Counted like the link graph: one per pair of notes, so `[[Levain]]` and `[[Sourdough Starter]]` to the same note are one link.
    links: one("SELECT count(*) AS n FROM (SELECT DISTINCT src, dst FROM links WHERE dst IS NOT NULL AND dst != src)"),
    tags: one("SELECT count(DISTINCT tag) AS n FROM tags"),
  };
}
