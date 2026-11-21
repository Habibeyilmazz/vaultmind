import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_CHUNK_CHARS, parseNote } from "../src/parse.ts";
import { renderNote } from "../src/render.ts";

test("frontmatter: title, tags, aliases", () => {
  const note = parseNote("a/b.md", "---\ntitle: Real Title\ntags: [Baking, '#bread']\naliases: Levain, Mother\n---\n# Heading\nbody");
  assert.equal(note.title, "Real Title");
  assert.deepEqual(note.tags, ["baking", "bread"]);
  assert.deepEqual(note.aliases, ["Levain", "Mother"]);
  assert.equal(note.body, "# Heading\nbody");
});

test("title falls back to first H1, then file name", () => {
  assert.equal(parseNote("x/File Name.md", "# From Heading\ntext").title, "From Heading");
  assert.equal(parseNote("x/File Name.md", "just text").title, "File Name");
});

test("broken YAML is ignored, the note is still parsed", () => {
  const note = parseNote("n.md", "---\ntitle: [unclosed\n---\nhello #tag");
  assert.equal(note.title, "n");
  assert.deepEqual(note.tags, ["tag"]);
});

test("inline tags: nested, unicode; not in code, URLs or headings", () => {
  const note = parseNote("n.md", "# Title\ntext #project/active and #café\nsee http://example.com/#anchor and `#code`\n```\n#fenced\n```\nissue #42");
  assert.deepEqual(note.tags, ["café", "project/active"]);
});

test("links: wikilinks with alias, heading, embed; markdown links; none from code", () => {
  const note = parseNote(
    "n.md",
    "[[Alpha]] [[Beta|shown]] [[Gamma#Part]] ![[Delta]] [[#local]] [[Alpha]]\n[md](sub/My%20Note.md#x) [web](https://example.com/page.md)\n`[[Code]]`\n```\n[[Fenced]]\n```",
  );
  assert.deepEqual(note.links, ["Alpha", "Beta", "Gamma", "Delta", "sub/My Note.md"]);
});

test("chunks follow headings and carry the heading path and line", () => {
  const raw = "---\ntitle: T\n---\nintro\n\n# One\nalpha\n\n## Two\nbeta\n\n# Three\n\n## Empty\n\n## Four\ngamma";
  const chunks = parseNote("n.md", raw).chunks;
  assert.deepEqual(chunks, [
    { heading: "", text: "intro", line: 4 },
    { heading: "One", text: "alpha", line: 6 },
    { heading: "One > Two", text: "beta", line: 9 },
    { heading: "Three > Four", text: "gamma", line: 16 },
  ]);
});

test("a '#' line inside a code fence is not a heading", () => {
  const chunks = parseNote("n.md", "# A\n```sh\n# comment\n```\nafter").chunks;
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].text, /# comment/);
});

test("a fence closes only on its own marker, so nested fences do not swallow the rest of the note", () => {
  const note = parseNote("n.md", "# A\n~~~\n```\n# not a heading [[InFence]]\n~~~\n\n## B\n````md\n```\n# still code\n```\n````\nafter #tag [[Out]]");
  assert.deepEqual(note.chunks.map((chunk) => chunk.heading), ["A", "A > B"]);
  assert.deepEqual(note.links, ["Out"]);
  assert.deepEqual(note.tags, ["tag"]);
});

test("links and tags written in a heading count", () => {
  const note = parseNote("n.md", "# Title\n\n## See [[Other Note]] and [md](sub/Third.md) #topic\n\ntext");
  assert.deepEqual(note.links, ["Other Note", "sub/Third.md"]);
  assert.deepEqual(note.tags, ["topic"]);
});

test("long sections are split at paragraph breaks", () => {
  const paragraph = "word ".repeat(120).trim(); // 599 chars
  const chunks = parseNote("n.md", `# Long\n${paragraph}\n\n${paragraph}\n\n${paragraph}`).chunks;
  assert.equal(chunks.length, 3);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= MAX_CHUNK_CHARS);
    assert.equal(chunk.heading, "Long");
  }
});

test("a note with no body text gets one chunk made of its headings", () => {
  assert.deepEqual(parseNote("n.md", "---\ntitle: T\n---\n# One\n\n## Two\n").chunks, [{ heading: "", text: "One\nTwo", line: 4 }]);
  assert.deepEqual(parseNote("n.md", "").chunks, [{ heading: "", text: "", line: 1 }]);
});

test("a hostile note full of unclosed link openers is parsed in linear time", () => {
  // Before the fix each "[[" scanned to the end of the line: a 400 KB note took minutes and froze the server.
  const start = performance.now();
  for (const unit of ["[[", "![[", "[[a|", "[[a#", "[a]("]) parseNote("x.md", `${unit.repeat(60_000)}\n[[Real Note]] and [x](other.md)`);
  for (const unit of ["[[", "![[", "[[a|", "[[a#", "[a](", "[a](<", "![a]("]) renderNote(unit.repeat(30_000), () => undefined);
  assert.ok(performance.now() - start < 3000, `took ${Math.round(performance.now() - start)} ms`);
  assert.deepEqual(parseNote("x.md", "[[[[Real Note]] [a [b](c.md)").links, ["Real Note", "c.md"]);
});

test("frontmatter values that are not text never become tags or aliases called null or [object Object]", () => {
  const note = parseNote("n.md", "---\ntitle: 2024\ntags:\n  - {a: b}\n  - null\n  - 12\n  - real\n  - [x, y]\naliases: [null, true, Short]\n---\nbody");
  assert.deepEqual(note.tags, ["12", "real"]);
  assert.deepEqual(note.aliases, ["Short"]);
  assert.equal(note.title, "2024");
});
