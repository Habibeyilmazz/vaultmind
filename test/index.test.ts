import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { embedPending, indexVault, listNotes } from "../src/indexer.ts";
import { allTags, filterNotes, ftsQuery, getNote, HL_START, linkGraph, parseQuery, recentNotes, relatedNotes, search, stats } from "../src/search.ts";
import { fakeEmbedder, tempVault } from "./helpers.ts";

const execFileAsync = promisify(execFile);

function indexed() {
  const dir = tempVault();
  const db = openDb(":memory:");
  indexVault(db, dir);
  return { dir, db };
}

test("listNotes skips dot-directories and non-markdown files", () => {
  const dir = tempVault();
  writeFileSync(join(dir, "image.png"), "x");
  const files = listNotes(dir);
  assert.equal(files.length, 13);
  assert.ok(files.includes("kitchen/Sourdough Starter.md"));
});

test("indexing is incremental: unchanged files are skipped, edits and deletions are picked up", async () => {
  const { dir, db } = indexed();
  assert.deepEqual(indexVault(db, dir), { scanned: 13, added: 0, updated: 0, removed: 0, skipped: 0 });

  writeFileSync(join(dir, "Inbox.md"), "# Inbox\n\nzebra crossing");
  rmSync(join(dir, "travel/Lisbon Trip.md"));
  assert.deepEqual(indexVault(db, dir), { scanned: 12, added: 0, updated: 1, removed: 1, skipped: 0 });
  assert.equal(getNote(db, "Lisbon Trip"), undefined);
  assert.equal((await search(db, "zebra")).hits[0].path, "Inbox.md");
  assert.equal((await search(db, "someday")).hits.length, 0, "old Inbox text must leave the keyword index");
  assert.deepEqual(getNote(db, "Espresso Dialing In")!.links, [], "the link to the deleted note is dangling again");
});

test("an unreadable or oversized file is skipped, the rest is indexed", () => {
  const dir = tempVault();
  symlinkSync(join(dir, "does-not-exist.md"), join(dir, "Dangling.md"));
  writeFileSync(join(dir, "Huge.md"), "x".repeat(5 * 1024 * 1024 + 1));
  mkdirSync(join(dir, "Folder.md"));
  const db = openDb(":memory:");
  const result = indexVault(db, dir);
  assert.equal(result.added, 13);
  assert.equal(result.skipped, 1, "the oversized file; the dangling symlink and the folder are not files at all");
  assert.equal(stats(db).notes, 13);
});

test("links resolve by file name, alias and heading link; code is ignored; dangling links are kept", () => {
  const { dir, db } = indexed();
  const loaf = getNote(db, "kitchen/Weekend Loaf.md")!;
  assert.deepEqual(loaf.links, [{ path: "kitchen/Sourdough Starter.md", title: "Sourdough Starter" }]);
  assert.deepEqual(loaf.backlinks.map((n) => n.title), ["Home", "Sourdough Starter"]);

  const inbox = getNote(db, "inbox")!;
  assert.deepEqual(inbox.unresolved, ["Fermentation Science"]);
  assert.deepEqual(inbox.tags, ["someday"]);

  writeFileSync(join(dir, "Fermentation Science.md"), "# Fermentation Science\nyeast");
  indexVault(db, dir);
  assert.deepEqual(getNote(db, "Inbox")!.unresolved, [], "a new note satisfies the old dangling link");
});

test("getNote finds notes by path, file name, alias and title, case-insensitively", () => {
  const { db } = indexed();
  for (const name of ["kitchen/Sourdough Starter.md", "kitchen/sourdough starter", "Sourdough Starter", "levain", "SRS"]) {
    assert.ok(getNote(db, name), name);
  }
  assert.equal(getNote(db, "levain")!.title, "Sourdough Starter");
  assert.equal(getNote(db, "../../etc/passwd"), undefined);
});

test("keyword search ranks the right section first and highlights matches", async () => {
  const { db } = indexed();
  const result = await search(db, "feeding schedule");
  assert.equal(result.mode, "keyword");
  assert.equal(result.hits[0].title, "Sourdough Starter");
  assert.equal(result.hits[0].heading, "Sourdough Starter > Feeding schedule");
  assert.ok(result.hits[0].snippet.includes(HL_START));
  assert.equal(new Set(result.hits.map((h) => h.path)).size, result.hits.length, "one hit per note");
});

test("search excerpts keep list items apart with a bullet", async () => {
  const { db } = indexed();
  const hit = (await search(db, "anemometer")).hits[0];
  assert.equal(hit.heading, "Weather Station > Open questions");
  assert.match(hit.snippet, /^• Does the rain gauge .*winter\? • Wind speed/);
});

test("keyword search: stemming, diacritics, tags, prefix, paging", async () => {
  const { db } = indexed();
  assert.equal((await search(db, "cafe creme")).hits[0].title, "Espresso Dialing In");
  assert.ok((await search(db, "fermenting")).hits.length > 0, "porter stemming matches 'ferment'");
  assert.ok((await search(db, "electronics")).hits.some((h) => h.title === "Weather Station"), "tags are searchable");
  assert.equal((await search(db, "SRS")).hits[0].title, "Spaced Repetition", "aliases are searchable");
  assert.deepEqual((await search(db, "levain")).hits.map((h) => h.title).sort(), ["Sourdough Starter", "Weekend Loaf"]);
  assert.equal((await search(db, "sourd")).hits.length, 0);
  assert.equal((await search(db, "sourd", { prefix: true })).hits[0].title, "Sourdough Starter");

  const all = await search(db, "coffee", { limit: 50 });
  const page = await search(db, "coffee", { limit: 1, offset: 1 });
  assert.equal(page.total, all.total);
  assert.deepEqual(page.hits[0].path, all.hits[1].path);
});

test("parseQuery splits tag: and path: operators off the words", () => {
  assert.deepEqual(parseQuery("tag:garden  water PATH:projects"), { text: "water", filter: { tags: ["garden"], folder: "projects" } });
  assert.deepEqual(parseQuery('tag:#book tag:health path:"my notes/2024" sleep'), { text: "sleep", filter: { tags: ["#book", "health"], folder: "my notes/2024" } });
  assert.deepEqual(parseQuery("mytag:x tag: how"), { text: "mytag:x tag: how", filter: { tags: [], folder: undefined } }, "only whole operators with a value");
});

test("filters: tags (nested count, all must match), folder prefix, case-insensitive", async () => {
  const { db } = indexed();
  const paths = (filter: Parameters<typeof filterNotes>[1]) => {
    const ids = filterNotes(db, filter);
    return ids && [...ids].map((id) => (db.prepare("SELECT title FROM notes WHERE id = ?").get(id) as { title: string }).title).sort();
  };
  assert.equal(paths({}), undefined, "an empty filter is no filter");
  assert.equal(paths({ tags: [" "], folder: "./" }), undefined);
  assert.deepEqual(paths({ tags: ["project"] }), ["Garden Irrigation", "Weather Station"], "#project also covers #project/active");
  assert.deepEqual(paths({ tags: ["#Project/Active"] }), ["Weather Station"]);
  assert.deepEqual(paths({ tags: ["proj"] }), [], "a tag is not a prefix of another tag");
  assert.deepEqual(paths({ tags: ["book", "health"] }), ["Why We Sleep"]);
  assert.deepEqual(paths({ folder: "Kitchen/" }), ["Espresso Dialing In", "Sourdough Starter", "Weekend Loaf"]);
  assert.deepEqual(paths({ folder: "kitch" }), [], "a folder is matched whole");
  assert.deepEqual(paths({ folder: "health", tags: ["running"] }), ["Running Log"]);
  assert.deepEqual({ ...allTags(db)[0] }, { tag: "health", notes: 3 });
});

test("search and recent notes keep to the filter", async () => {
  const { db } = indexed();
  await embedPending(db, fakeEmbedder);
  for (const mode of ["keyword", "semantic", "auto"] as const) {
    const result = await search(db, "sleep", { mode, embedder: fakeEmbedder, filter: { folder: "reading" } });
    assert.ok(result.hits.length > 0, mode);
    assert.ok(result.hits.every((hit) => hit.path.startsWith("reading/")), mode);
    assert.equal(result.inScope, 3);
  }
  assert.equal((await search(db, "sleep")).inScope, undefined);
  assert.deepEqual(await search(db, "sleep", { filter: { tags: ["nope"] } }), { mode: "keyword", total: 0, hits: [], inScope: 0 });

  // No words, only a filter: the notes that pass it, newest first.
  const listed = await search(db, " ", { filter: { tags: ["baking"] } });
  assert.deepEqual(listed.hits.map((hit) => hit.title).sort(), ["Sourdough Starter", "Weekend Loaf"]);
  assert.equal(listed.total, 2);
  assert.ok(listed.hits.every((hit) => hit.snippet && hit.line >= 1));

  const recent = recentNotes(db, 1, 0, { tags: ["health"] });
  assert.equal(recent.total, 3);
  assert.equal(recent.notes.length, 1);
  assert.ok(recent.notes[0].tags.includes("health"));
});

test("user input is never interpreted as FTS5 syntax", async () => {
  const { db } = indexed();
  assert.equal(ftsQuery('title:"x" AND (NEAR*'), '"title" OR "x" OR "NEAR"');
  assert.equal(ftsQuery("how do I keep my starter alive"), '"keep" OR "starter" OR "alive"');
  assert.equal(ftsQuery("to be or not to be"), '"not"');
  assert.equal(ftsQuery("who are you"), '"who" OR "are" OR "you"', "all stopwords: keep them");
  assert.equal(ftsQuery("sour dou", true), '"sour" OR "dou"*');
  for (const query of ['"', "AND OR NOT", "a* (b", "col:x -y ^z", "", "   ", "'; DROP TABLE notes; --"]) {
    await search(db, query);
  }
  assert.equal(stats(db).notes, 13);
});

test("semantic mode needs embeddings; with them, auto becomes hybrid", async () => {
  const { dir, db } = indexed();
  await assert.rejects(search(db, "bread", { mode: "semantic", embedder: fakeEmbedder }), /Semantic search is unavailable/);

  assert.equal(await embedPending(db, fakeEmbedder), stats(db).chunks);
  assert.equal(stats(db).embedded, stats(db).chunks);
  assert.equal(await embedPending(db, fakeEmbedder), 0, "nothing left to embed");

  const hybrid = await search(db, "rain gauge heater in winter", { embedder: fakeEmbedder });
  assert.equal(hybrid.mode, "hybrid");
  assert.ok(["Weather Station", "Inbox"].includes(hybrid.hits[0].title));
  const semantic = await search(db, "tipping bucket rain gauge", { mode: "semantic", embedder: fakeEmbedder });
  assert.equal(semantic.hits[0].title, "Weather Station");
  assert.equal((await search(db, "rain", { embedder: null })).mode, "keyword", "no embedder at query time means keyword");

  // Only the edited note is embedded again.
  writeFileSync(join(dir, "Inbox.md"), "# Inbox\nfresh text");
  indexVault(db, dir);
  assert.equal(await embedPending(db, fakeEmbedder), 1);
  // A different model invalidates every stored vector.
  assert.equal(await embedPending(db, { ...fakeEmbedder, id: "other-model" }), stats(db).chunks);
});

test("related notes combine links, shared tags and content", async () => {
  const { db } = indexed();
  const keywordOnly = (await relatedNotes(db, "Sourdough Starter"))!;
  assert.equal(keywordOnly[0].title, "Weekend Loaf");
  assert.ok(keywordOnly[0].reasons.includes("linked from this note"));
  assert.ok(keywordOnly[0].reasons.includes("links to this note"));
  assert.ok(keywordOnly[0].reasons.some((r) => r.includes("#baking")));
  assert.ok(!keywordOnly.some((n) => n.title === "Sourdough Starter"), "never related to itself");

  await embedPending(db, fakeEmbedder);
  const withVectors = (await relatedNotes(db, "Sourdough Starter", 3))!;
  assert.equal(withVectors.length, 3);
  assert.equal(withVectors[0].title, "Weekend Loaf");
  assert.equal(await relatedNotes(db, "No Such Note"), undefined);
});

test("one long note cannot crowd other notes out of the results", async () => {
  const { dir, db } = indexed();
  const sections = Array.from({ length: 150 }, (_, i) => `## Day ${i}\n\nzanzibar zanzibar zanzibar`).join("\n\n");
  writeFileSync(join(dir, "Journal.md"), `# Journal\n\n${sections}`);
  writeFileSync(join(dir, "Postcard.md"), "# Postcard\n\nA long card that mentions zanzibar only once, among many other words about the trip.");
  indexVault(db, dir);
  const keyword = await search(db, "zanzibar");
  assert.deepEqual(keyword.hits.map((h) => h.title), ["Journal", "Postcard"]);
  assert.equal(keyword.total, 2);

  await embedPending(db, fakeEmbedder);
  const hybrid = await search(db, "zanzibar", { embedder: fakeEmbedder });
  assert.deepEqual(hybrid.hits.map((h) => h.title).sort(), ["Journal", "Postcard"]);
});

test("a note with headings but no body text is still found by its title and headings", async () => {
  const { dir, db } = indexed();
  writeFileSync(join(dir, "Stub.md"), "# Quokka\n\n## Wombat\n");
  indexVault(db, dir);
  assert.equal((await search(db, "quokka")).hits[0]?.path, "Stub.md");
  assert.equal((await search(db, "wombat")).hits[0]?.path, "Stub.md");
});

test("a link prefers the note next to it over a same-named note elsewhere", () => {
  const { dir, db } = indexed();
  mkdirSync(join(dir, "b"));
  writeFileSync(join(dir, "Target.md"), "# Root target");
  writeFileSync(join(dir, "b/Target.md"), "# Nested target");
  writeFileSync(join(dir, "b/Source.md"), "[local](Target.md) and [[Target]] and [up](../Home.md)");
  writeFileSync(join(dir, "Other.md"), "[[Target]]");
  indexVault(db, dir);
  assert.deepEqual(getNote(db, "b/Source.md")!.links.map((n) => n.path), ["Home.md", "b/Target.md"]);
  assert.deepEqual(getNote(db, "Other.md")!.links.map((n) => n.path), ["Target.md"]);
  assert.equal(getNote(db, "Target", "b/Source.md")!.title, "Nested target");
});

test("an embedding that finishes after its note changed is not written to the new text", async () => {
  const { dir, db } = indexed();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const slow = { id: fakeEmbedder.id, embed: async (texts: string[]) => (await gate, fakeEmbedder.embed(texts)) };
  db.exec("DELETE FROM chunks_fts; DELETE FROM notes");
  writeFileSync(join(dir, "Only.md"), "# Only\n\nold text");
  for (const file of listNotes(dir)) if (file !== "Only.md") rmSync(join(dir, file));
  indexVault(db, dir);
  const pending = embedPending(db, slow);
  writeFileSync(join(dir, "Only.md"), "# Only\n\nnew and different text");
  indexVault(db, dir); // replaces the chunk while its old text is still being embedded
  release();
  await pending;
  assert.equal(stats(db).embedded, 0, "the stale vector was dropped, the new chunk still waits for its own");
  assert.equal(await embedPending(db, fakeEmbedder), 1);
});

test("recent notes and link graph", () => {
  const { dir, db } = indexed();
  writeFileSync(join(dir, "Newest.md"), "# Newest\n[[Home]]");
  indexVault(db, dir);
  const recent = recentNotes(db, 3);
  assert.equal(recent.total, 14);
  assert.equal(recent.notes.length, 3);
  assert.equal(recent.notes[0].title, "Newest");

  const graph = linkGraph(db);
  assert.equal(graph.nodes.length, 14);
  const ids = new Set(graph.nodes.map((n) => n.id));
  assert.ok(graph.edges.length >= 20);
  assert.ok(graph.edges.every((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target));
});

test("a folder the user cannot read is skipped instead of stopping the whole index", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  const dir = tempVault();
  mkdirSync(join(dir, "locked"));
  writeFileSync(join(dir, "locked", "secret.md"), "hidden");
  chmodSync(join(dir, "locked"), 0);
  try {
    const notes = listNotes(dir);
    assert.ok(notes.length > 5 && !notes.includes("locked/secret.md"));
  } finally {
    chmodSync(join(dir, "locked"), 0o755);
  }
});

test("several processes opening and indexing one brand-new index at once all succeed", async () => {
  const dir = tempVault();
  const db = join(dir, "..", `${dir.split(/[\\/]/).pop()}-index.db`);
  const script = `import { openDb } from ${JSON.stringify(new URL("../src/db.ts", import.meta.url).href)};
import { indexVault } from ${JSON.stringify(new URL("../src/indexer.ts", import.meta.url).href)};
indexVault(openDb(process.argv[1]), process.argv[2]);`;
  for (let round = 0; round < 10; round++) {
    const file = `${db}.${round}`;
    const runs = Array.from({ length: 8 }, () => execFileAsync(process.execPath, ["--input-type=module", "-e", script, file, dir]));
    const results = await Promise.allSettled(runs);
    const failed = results.filter((r) => r.status === "rejected");
    assert.equal(failed.length, 0, String((failed[0] as PromiseRejectedResult | undefined)?.reason?.stderr ?? ""));
  }
});

test("a long excerpt is never cut through an emoji", async () => {
  const dir = tempVault();
  writeFileSync(join(dir, "Emoji.md"), `---\ntags: [emojitest]\n---\n${"a".repeat(219)}😀😀 and more`);
  const db = openDb(":memory:");
  indexVault(db, dir);
  const { text, filter } = parseQuery("tag:emojitest");
  const { hits } = await search(db, text, { filter });
  assert.equal(hits.length, 1);
  assert.doesNotMatch(hits[0].snippet, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
});
