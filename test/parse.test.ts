import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_CHUNK_CHARS, parseNote } from "../src/parse.ts";

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

test("long sections are split at paragraph breaks", () => {
  const paragraph = "word ".repeat(120).trim(); // 599 chars
  const chunks = parseNote("n.md", `# Long\n${paragraph}\n\n${paragraph}\n\n${paragraph}`).chunks;
  assert.equal(chunks.length, 3);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= MAX_CHUNK_CHARS);
    assert.equal(chunk.heading, "Long");
  }
});
