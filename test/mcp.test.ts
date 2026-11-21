import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { tempVault } from "./helpers.ts";

// End to end: the real CLI entry point, spoken to over stdio the way Claude Code does it.
const dir = tempVault();
const client = new Client({ name: "vaultmind-test", version: "1.0.0" });

before(async () => {
  writeFileSync(join(dir, "Long.md"), `# Long\n\n${"lorem ipsum dolor sit amet ".repeat(1500)}`);
  writeFileSync(join(dir, "Emoji.md"), `${"a".repeat(24_999)}😀😀 end`);
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(import.meta.dirname, "..", "src", "cli.ts"), "mcp", "--vault", dir, "--no-embed"],
      env: getDefaultEnvironment(),
    }),
  );
});
after(() => client.close());

const text = (result: Awaited<ReturnType<typeof client.callTool>>) => (result.content as { type: string; text: string }[])[0].text;

test("lists four read-only tools with descriptions", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["get_note", "recent_notes", "related_notes", "search_notes"]);
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
    assert.ok((tool.description ?? "").length > 40, tool.name);
  }
});

test("search_notes returns the matching section as markdown and as JSON", async () => {
  const markdown = await client.callTool({ name: "search_notes", arguments: { query: "what is the feeding schedule for my starter" } });
  assert.ok(!markdown.isError);
  assert.match(text(markdown), /## Sourdough Starter\npath: kitchen\/Sourdough Starter\.md \| section: Sourdough Starter > Feeding schedule/);
  assert.match(text(markdown), /discard all but 20 g/);

  const paged = await client.callTool({ name: "search_notes", arguments: { query: "coffee", limit: 1, response_format: "json" } });
  const page = paged.structuredContent as { total: number; count: number; has_more: boolean; next_offset: number; mode: string; results: { path: string }[] };
  assert.equal(page.mode, "keyword");
  assert.equal(page.count, 1);
  assert.ok(page.total > 1);
  assert.equal(page.has_more, true);
  assert.equal(page.next_offset, 1);
  assert.deepEqual(JSON.parse(text(paged)), page);

  const none = await client.callTool({ name: "search_notes", arguments: { query: "xyzzyplugh" } });
  assert.match(text(none), /No notes match/);
});

test("get_note resolves aliases, lists links, and pages long notes", async () => {
  const note = await client.callTool({ name: "get_note", arguments: { note: "levain" } });
  assert.match(text(note), /^# Sourdough Starter\n\npath: kitchen\/Sourdough Starter\.md/);
  assert.match(text(note), /tags: #baking #fermentation/);
  assert.match(text(note), /linked from: .*Weekend Loaf \(kitchen\/Weekend Loaf\.md\)/);
  assert.match(text(note), /## Feeding schedule/);

  const long = await client.callTool({ name: "get_note", arguments: { note: "Long", response_format: "json" } });
  const first = long.structuredContent as { body: string; has_more: boolean; next_offset: number };
  assert.equal(first.body.length, 25_000);
  assert.equal(first.has_more, true);
  const rest = await client.callTool({ name: "get_note", arguments: { note: "Long", offset: first.next_offset, response_format: "json" } });
  assert.equal((rest.structuredContent as { has_more: boolean }).has_more, false);
});

test("related_notes and recent_notes", async () => {
  const related = await client.callTool({ name: "related_notes", arguments: { note: "Sleep Routine" } });
  assert.match(text(related), /- Why We Sleep \(reading\/Why We Sleep\.md\): .*shares #health/);
  const recent = await client.callTool({ name: "recent_notes", arguments: { limit: 3 } });
  assert.match(text(recent), /# Recently modified notes \(1-3 of 15\)/);
  assert.match(text(recent), /More: call again with offset=3\./);
});

test("search_notes and recent_notes filter by tags and folder", async () => {
  const filtered = await client.callTool({ name: "search_notes", arguments: { query: "sleep", folder: "reading", response_format: "json" } });
  const page = filtered.structuredContent as { results: { path: string }[] };
  assert.ok(page.results.length > 0);
  assert.ok(page.results.every((r) => r.path.startsWith("reading/")));

  const operators = await client.callTool({ name: "search_notes", arguments: { query: "tag:project/active" } });
  assert.match(text(operators), /^# 1 note match "tag:project\/active" among notes tagged #project\/active/);
  assert.match(text(operators), /## Weather Station/);

  const both = await client.callTool({ name: "search_notes", arguments: { query: "water tag:project", tags: ["#garden"] } });
  assert.match(text(both), /among notes tagged #project and #garden/);
  assert.match(text(both), /## Garden Irrigation/);
  assert.doesNotMatch(text(both), /## Weather Station/);

  const unknown = await client.callTool({ name: "search_notes", arguments: { query: "water", tags: ["gardening"] } });
  assert.match(text(unknown), /^No note is tagged #gardening\. Tags in this vault \(most used first\): #health \(3\),.*#garden \(1\)/);

  const books = await client.callTool({ name: "recent_notes", arguments: { tags: ["book"] } });
  assert.match(text(books), /^# Recently modified notes tagged #book \(1-2 of 2\)/);
  const none = await client.callTool({ name: "recent_notes", arguments: { folder: "nowhere" } });
  assert.match(text(none), /^No note is in folder 'nowhere'\./);
});

test("bad input comes back as a tool error the model can act on", async () => {
  const missing = await client.callTool({ name: "get_note", arguments: { note: "No Such Note" } });
  assert.equal(missing.isError, true);
  assert.match(text(missing), /Use search_notes or recent_notes/);
  const invalid = await client.callTool({ name: "search_notes", arguments: { query: "" } });
  assert.equal(invalid.isError, true);
  const semantic = await client.callTool({ name: "search_notes", arguments: { query: "bread", mode: "semantic" } });
  assert.equal(semantic.isError, true);
  assert.match(text(semantic), /Semantic search is unavailable/);
});

const wellFormed = (s: string) => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);

test("get_note never cuts an emoji in half at a page boundary", async () => {
  const body = `${"a".repeat(24_999)}😀😀 end`;
  const call = async (offset: number) =>
    (await client.callTool({ name: "get_note", arguments: { note: "Emoji", offset, response_format: "json" } })).structuredContent as {
      body: string;
      has_more: boolean;
      next_offset: number;
    };
  const first = await call(0);
  assert.ok(wellFormed(first.body), "first page ends in half an emoji");
  const second = await call(first.next_offset);
  assert.ok(wellFormed(second.body));
  assert.equal(first.body + second.body, body);
});

test("with --allow-write, write_note saves a note that search finds at once, and refuses to overwrite", async () => {
  const writable = tempVault();
  const writer = new Client({ name: "vaultmind-test", version: "1.0.0" });
  await writer.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(import.meta.dirname, "..", "src", "cli.ts"), "mcp", "--vault", writable, "--no-embed", "--allow-write"],
      env: getDefaultEnvironment(),
    }),
  );
  try {
    const tool = (await writer.listTools()).tools.find((t) => t.name === "write_note");
    assert.equal(tool?.annotations?.readOnlyHint, false);
    assert.equal(tool?.annotations?.destructiveHint, false);

    const created = await writer.callTool({ name: "write_note", arguments: { path: "inbox/Plumber", content: "The plumber comes on Tuesday. #home" } });
    assert.equal(text(created), "Created inbox/Plumber.md.");
    const found = await writer.callTool({ name: "search_notes", arguments: { query: "plumber tag:home" } });
    assert.match(text(found), /## Plumber\npath: inbox\/Plumber\.md/);

    const again = await writer.callTool({ name: "write_note", arguments: { path: "inbox/Plumber.md", content: "overwrite" } });
    assert.equal(again.isError, true);
    assert.match(text(again), /already exists/);

    const appended = await writer.callTool({ name: "write_note", arguments: { path: "inbox/Plumber.md", content: "Bring the spare key.", append: true } });
    assert.equal(text(appended), "Appended to inbox/Plumber.md.");
    const note = await writer.callTool({ name: "get_note", arguments: { note: "Plumber" } });
    assert.match(text(note), /The plumber comes on Tuesday\. #home\n\nBring the spare key\./);

    const escape = await writer.callTool({ name: "write_note", arguments: { path: "../escape", content: "x" } });
    assert.equal(escape.isError, true);
    assert.match(text(escape), /'\.\.' path parts are not allowed/);
  } finally {
    await writer.close();
  }
});
