import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { openDb } from "../src/db.ts";
import { embedPending, indexVault, listNotes } from "../src/indexer.ts";
import { ftsQuery, getNote, HL_START, linkGraph, recentNotes, relatedNotes, search, stats } from "../src/search.ts";
import { fakeEmbedder, tempVault } from "./helpers.ts";

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

test("keyword search: stemming, diacritics, tags, prefix, paging", async () => {
  const { db } = indexed();
  assert.equal((await search(db, "cafe creme")).hits[0].title, "Espresso Dialing In");
  assert.ok((await search(db, "fermenting")).hits.length > 0, "porter stemming matches 'ferment'");
  assert.ok((await search(db, "electronics")).hits.some((h) => h.title === "Weather Station"), "tags are searchable");
  assert.equal((await search(db, "sourd")).hits.length, 0);
  assert.equal((await search(db, "sourd", { prefix: true })).hits[0].title, "Sourdough Starter");

  const all = await search(db, "coffee", { limit: 50 });
  const page = await search(db, "coffee", { limit: 1, offset: 1 });
  assert.equal(page.total, all.total);
  assert.deepEqual(page.hits[0].path, all.hits[1].path);
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
