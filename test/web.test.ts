import assert from "node:assert/strict";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { ask, AskError } from "../src/ask.ts";
import { renderNote } from "../src/render.ts";
import { Vault } from "../src/vault.ts";
import { handle } from "../src/web.ts";
import { fakeEmbedder, tempVault } from "./helpers.ts";

function openVault(embed = false) {
  const vault = new Vault({ dir: tempVault(), dbPath: ":memory:", embed, loader: async () => fakeEmbedder });
  vault.sync();
  return vault;
}
const get = async (vault: Vault, path: string, init?: RequestInit) => {
  const response = await handle(vault, new Request(`http://127.0.0.1:4100${path}`, init));
  return { response, data: (await response.json()) as Record<string, any> };
};

test("renderNote: wikilinks become note links, missing notes are marked, code is left alone", () => {
  const resolve = (target: string) => (target === "Known" ? "dir/Known Note.md" : undefined);
  const html = renderNote("See [[Known]], [[Known|the alias]], [[Known#Part]], ![[Known]] and [[Unknown]].\n\n`[[Known]]`", resolve);
  assert.equal(html.match(/<a class="wikilink" href="#\/note\/dir%2FKnown%20Note\.md">/g)?.length, 4);
  assert.match(html, />the alias<\/a>/);
  assert.match(html, />Known &gt; Part<\/a>/);
  assert.match(html, /<span class="missing"[^>]*>Unknown<\/span>/);
  assert.match(html, /<code>\[\[Known\]\]<\/code>/);
});

test("renderNote: nothing in a note can run script or load remote content", () => {
  const html = renderNote(
    [
      "<script>alert(1)</script>",
      '<img src=x onerror="alert(1)">',
      "[click](javascript:alert(1))",
      "[data](data:text/html,<script>1</script>)",
      "![tracker](https://example.com/pixel.png)",
      "[[<b>bold</b>]]",
      "[ok](https://example.com/a?b=1&c=2)",
      "[rel](sub/Known.md)",
    ].join("\n\n"),
    () => undefined,
  );
  assert.doesNotMatch(html, /<script|<img|<b>|javascript:|data:text|onerror="/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /\[image: tracker\]/);
  assert.match(html, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">ok<\/a>/);
});

test("web API: status, search, note, related, recent, graph", async () => {
  const vault = openVault();
  const status = await get(vault, "/api/status");
  assert.equal(status.data.notes, 13);
  assert.equal(status.data.semantic, false);
  assert.match(status.response.headers.get("content-security-policy")!, /default-src 'none'; script-src 'self'/);

  const found = await get(vault, "/api/search?q=sourd");
  assert.equal(found.data.hits[0].title, "Sourdough Starter", "the last word is a prefix");
  assert.equal(found.data.hits[0].text, undefined, "full section text is not sent to the list");
  assert.deepEqual((await get(vault, "/api/search?q=")).data.hits, []);
  assert.equal((await get(vault, `/api/search?q=${"x".repeat(501)}`)).response.status, 400);

  const note = await get(vault, `/api/note?path=${encodeURIComponent("kitchen/Weekend Loaf.md")}`);
  assert.equal(note.data.title, "Weekend Loaf");
  assert.match(note.data.html, /<a class="wikilink" href="#\/note\/kitchen%2FSourdough%20Starter\.md">Levain<\/a>/);
  assert.match(note.data.html, /<table>/);
  assert.equal((await get(vault, "/api/note?path=..%2F..%2Fetc%2Fpasswd")).response.status, 404);

  assert.equal((await get(vault, "/api/related?path=Sleep%20Routine")).data.related[0].title, "Why We Sleep");
  assert.equal((await get(vault, "/api/related?path=nope")).response.status, 404);
  assert.equal((await get(vault, "/api/recent?limit=5")).data.notes.length, 5);
  assert.equal((await get(vault, "/api/graph")).data.nodes.length, 13);
});

test("web API: semantic search turns on once the vault is embedded", async () => {
  const vault = openVault(true);
  vault.keepFresh();
  await vault.idle();
  assert.equal((await get(vault, "/api/status")).data.semantic, true);
  assert.equal((await get(vault, "/api/search?q=rain+gauge")).data.mode, "hybrid");
});

test("web server: static files, and no access from other hosts or methods", async () => {
  const vault = openVault();
  const page = await handle(vault, new Request("http://localhost:4100/"));
  assert.match(await page.text(), /<title>vaultmind<\/title>/);
  assert.equal((await handle(vault, new Request("http://127.0.0.1:4100/app.js"))).headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.equal((await get(vault, "/nope")).response.status, 404);
  assert.equal((await get(vault, "/../package.json")).response.status, 404);
  assert.equal((await handle(vault, new Request("http://evil.example:4100/api/status"))).status, 403, "DNS rebinding");
  assert.equal((await get(vault, "/api/status", { method: "DELETE" })).response.status, 405);
});

test("ask endpoint: off without a key, and guarded against cross-site posts", async () => {
  const vault = openVault();
  const saved = { key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  try {
    const post = (headers: Record<string, string>, body = '{"question":"hi"}') => get(vault, "/api/ask", { method: "POST", headers, body });
    assert.equal((await get(vault, "/api/status")).data.ask, false);
    const off = await post({ "content-type": "application/json" });
    assert.equal(off.response.status, 503);
    assert.match(off.data.error, /ANTHROPIC_API_KEY/);
    assert.equal((await post({ "content-type": "application/json", origin: "https://evil.example" })).response.status, 403);
    assert.equal((await post({ "content-type": "text/plain" })).response.status, 415);

    process.env.ANTHROPIC_API_KEY = "test-placeholder";
    assert.equal((await get(vault, "/api/status")).data.ask, true);
    assert.equal((await post({ "content-type": "application/json" }, "not json")).response.status, 400);
    assert.equal((await post({ "content-type": "application/json" }, '{"question":""}')).response.status, 400);
  } finally {
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved.key;
    if (saved.token !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved.token;
  }
});

test("ask: sends the best sections as citable documents and numbers the cited sources", async () => {
  const vault = openVault();
  const requests: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
  const answer = await ask(vault, "How do I feed the sourdough starter?", async (params) => {
    requests.push(params);
    const documents = (params.messages[0].content as Anthropic.Beta.BetaContentBlockParam[]).filter((block) => block.type === "document");
    const index = documents.findIndex((doc) => doc.title?.startsWith("Sourdough Starter"));
    const cite = (cited_text: string) => ({ type: "char_location", cited_text, document_index: index, document_title: null, start_char_index: 0, end_char_index: 1, file_id: null });
    return {
      model: params.model,
      stop_reason: "end_turn",
      content: [
        { type: "text", text: "Feed it daily.", citations: [cite("Feed once a day"), cite("discard all but 20 g")] },
        { type: "text", text: " That is all.", citations: null },
      ],
    } as unknown as Anthropic.Beta.BetaMessage;
  });

  assert.equal(requests.length, 1);
  const content = requests[0].messages[0].content as Anthropic.Beta.BetaContentBlockParam[];
  const documents = content.filter((block) => block.type === "document");
  assert.ok(documents.length >= 2 && documents.length <= 8);
  assert.ok(documents.every((doc) => doc.citations?.enabled === true && doc.source.type === "text"));
  assert.deepEqual(content.at(-1), { type: "text", text: "How do I feed the sourdough starter?" });
  assert.equal(requests[0].fallbacks, "default");

  assert.equal(answer.answer, "Feed it daily. [1] That is all.");
  assert.equal(answer.sources.length, 1);
  assert.equal(answer.sources[0].path, "kitchen/Sourdough Starter.md");
  assert.deepEqual(answer.sources[0].quotes, ["Feed once a day", "discard all but 20 g"]);
});

test("ask: no matching notes means no API call; refusals and failures become readable errors", async () => {
  const vault = openVault();
  let calls = 0;
  const nothing = await ask(vault, "xyzzyplugh", async () => {
    calls++;
    throw new Error("must not be called");
  });
  assert.equal(calls, 0);
  assert.match(nothing.answer, /Nothing in the vault/);

  await assert.rejects(
    ask(vault, "starter", async () => ({ model: "m", stop_reason: "refusal", content: [] }) as unknown as Anthropic.Beta.BetaMessage),
    (error) => error instanceof AskError && /declined/.test(error.message),
  );
  // An account without the fallback beta gets a 400: the plain request is tried once.
  const seen: unknown[] = [];
  const plain = await ask(vault, "starter", async (params) => {
    seen.push(params.fallbacks);
    if (params.fallbacks) throw new Anthropic.BadRequestError(400, undefined, "unexpected beta", new Headers());
    return { model: "m", stop_reason: "end_turn", content: [{ type: "text", text: "ok", citations: null }] } as unknown as Anthropic.Beta.BetaMessage;
  });
  assert.deepEqual(seen, ["default", undefined]);
  assert.equal(plain.answer, "ok");
  await assert.rejects(
    ask(vault, "starter", async () => {
      throw new Anthropic.AuthenticationError(401, undefined, "bad key", new Headers());
    }),
    (error) => error instanceof AskError && /rejected the API key/.test(error.message),
  );

  await assert.rejects(
    ask(vault, "starter", async () => {
      throw new Error("socket hang up");
    }),
    (error) => error instanceof AskError && /socket hang up/.test(error.message),
  );
});
