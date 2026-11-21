import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { Db } from "./db.ts";
import type { Hit, NoteFilter } from "./search.ts";
import { allTags, getNote, parseQuery, recentNotes, relatedNotes, search } from "./search.ts";
import type { Vault } from "./vault.ts";

export const VERSION = "0.1.0";
const CHARACTER_LIMIT = 25_000;

const responseFormat = z.enum(["markdown", "json"]).default("markdown").describe("'markdown' for readable text, 'json' for structured data");
const noteName = z.string().min(1).max(500).describe("Vault-relative path ('kitchen/Sourdough Starter.md'), file name, alias or title of the note");
const tagsParam = z
  .array(z.string().min(1).max(100))
  .max(10)
  .optional()
  .describe("Only notes that have all of these tags, e.g. ['project']. '#' is optional; a tag also covers its nested tags (project covers project/active)");
const folderParam = z.string().min(1).max(500).optional().describe("Only notes inside this vault folder and its subfolders, e.g. 'projects' or 'journal/2024'");
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function reply(format: "markdown" | "json", data: Record<string, unknown>, markdown: () => string) {
  if (format === "json") return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], structuredContent: data };
  return { content: [{ type: "text" as const, text: markdown() }] };
}

const tagList = (tags: string[]) => (tags.length ? tags.map((tag) => `#${tag}`).join(" ") : "none");
const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const describeFilter = ({ tags = [], folder }: NoteFilter) =>
  [tags.length && `tagged ${tags.map((tag) => `#${tag.replace(/^#/, "")}`).join(" and ")}`, folder && `in folder '${folder}'`].filter(Boolean).join(" ");
/** When a filter matches no note at all, say so and show which tags exist, so the model can retry with a real one. */
const emptyScope = (db: Db, filter: NoteFilter) => {
  const tags = allTags(db).slice(0, 40);
  return `No note is ${describeFilter(filter)}.${tags.length ? ` Tags in this vault (most used first): ${tags.map((t) => `#${t.tag} (${t.notes})`).join(", ")}.` : ""}`;
};
const notFound = (name: string) => new Error(`No note matches '${name}'. Use search_notes or recent_notes to find a valid path.`);

/** Builds a fresh MCP server over an open vault. Tools are read-only: nothing here writes to the vault. */
export function createServer(vault: Vault): McpServer {
  const server = new McpServer({ name: "vaultmind", version: VERSION });

  server.registerTool(
    "search_notes",
    {
      title: "Search notes",
      description: `Search the user's Markdown/Obsidian vault and return the best matching section of each matching note.

Uses hybrid search (BM25 keywords + local embeddings) when the index has embeddings, keyword search otherwise; the result says which ran. Natural-language questions work.
Results are paginated: when more exist, the result gives next_offset.
Narrow the search with tags and folder. The query also accepts Obsidian-style operators: tag:garden path:projects.

Examples:
  - "What did I write about feeding a sourdough starter?" -> query="feeding sourdough starter"
  - "Find my notes on sleep and caffeine" -> query="sleep caffeine"
  - "What's the status of my active projects?" -> query="status", tags=["project/active"]
Use get_note to read a whole note once you know its path.`,
      inputSchema: z.strictObject({
        query: z.string().min(1).max(500).describe("Words or a question to search for"),
        limit: z.number().int().min(1).max(25).default(8).describe("Maximum number of notes to return"),
        offset: z.number().int().min(0).default(0).describe("Number of results to skip, for pagination"),
        mode: z
          .enum(["auto", "keyword", "semantic"])
          .default("auto")
          .describe("'auto' picks hybrid when embeddings exist; 'keyword' forces exact-word matching; 'semantic' forces meaning-only matching"),
        tags: tagsParam,
        folder: folderParam,
        response_format: responseFormat,
      }),
      annotations: READ_ONLY,
    },
    async ({ query, limit, offset, mode, tags, folder, response_format }) => {
      vault.keepFresh();
      const parsed = parseQuery(query);
      const filter = { tags: [...(parsed.filter.tags ?? []), ...(tags ?? [])], folder: folder ?? parsed.filter.folder };
      const result = await search(vault.db, parsed.text, { mode, limit, offset, filter, embedder: await vault.queryEmbedder() });
      const within = describeFilter(filter) ? ` among notes ${describeFilter(filter)}` : "";
      const render = (hits: Hit[]) => {
        const nextOffset = offset + hits.length;
        const hasMore = result.total > nextOffset;
        const page = {
          query,
          mode: result.mode,
          total: result.total,
          count: hits.length,
          offset,
          has_more: hasMore,
          ...(hasMore ? { next_offset: nextOffset } : {}),
          results: hits.map((hit) => ({ path: hit.path, title: hit.title, section: hit.heading, line: hit.line, tags: hit.tags, text: hit.text })),
        };
        const markdown = () =>
          [
            `# ${result.total} note${result.total === 1 ? "" : "s"} match "${query}"${within} (${result.mode} search), showing ${offset + 1}-${nextOffset}`,
            ...hits.map((hit) => `## ${hit.title}\npath: ${hit.path} | section: ${hit.heading || "(top)"} | line ${hit.line} | tags: ${tagList(hit.tags)}\n\n${hit.text}`),
            ...(hasMore ? [`More results: call again with offset=${nextOffset}.`] : []),
          ].join("\n\n");
        return { page, markdown };
      };
      if (result.hits.length === 0) {
        return reply(response_format, render([]).page, () =>
          result.inScope === 0 ? emptyScope(vault.db, filter) : `No notes match "${query}"${within} (${result.mode} search). Try fewer or different words.`,
        );
      }
      // Stay under the character limit by returning fewer notes, never by cutting text.
      let hits = result.hits;
      let out = render(hits);
      while (hits.length > 1 && out.markdown().length > CHARACTER_LIMIT) {
        hits = hits.slice(0, Math.ceil(hits.length / 2));
        out = render(hits);
      }
      return reply(response_format, out.page, out.markdown);
    },
  );

  server.registerTool(
    "get_note",
    {
      title: "Get note",
      description: `Read one note from the vault: its Markdown body, tags, frontmatter, outgoing links and backlinks.

Accepts a path, file name, alias or title (case-insensitive). Notes longer than ${CHARACTER_LIMIT} characters are returned in pieces; the result says which offset to ask for next.
Use search_notes first when you do not know which note you need.`,
      inputSchema: z.strictObject({
        note: noteName,
        offset: z.number().int().min(0).default(0).describe("Character offset into the note body, for reading long notes in pieces"),
        response_format: responseFormat,
      }),
      annotations: READ_ONLY,
    },
    async ({ note: name, offset, response_format }) => {
      vault.keepFresh();
      const note = getNote(vault.db, name);
      if (!note) throw notFound(name);
      let end = offset + CHARACTER_LIMIT;
      if (end < note.body.length && /[\ud800-\udbff]/.test(note.body[end - 1])) end--; // do not cut an emoji in half
      const body = note.body.slice(offset, end);
      const nextOffset = offset + body.length;
      const hasMore = nextOffset < note.body.length;
      const data = {
        path: note.path,
        title: note.title,
        tags: note.tags,
        modified: new Date(note.modified).toISOString(),
        frontmatter: note.frontmatter,
        links: note.links,
        unresolved_links: note.unresolved,
        backlinks: note.backlinks,
        body,
        has_more: hasMore,
        ...(hasMore ? { next_offset: nextOffset } : {}),
      };
      const refs = (list: { title: string; path: string }[]) => (list.length ? list.map((n) => `${n.title} (${n.path})`).join("; ") : "none");
      return reply(response_format, data, () =>
        [
          `# ${note.title}`,
          `path: ${note.path}\nmodified: ${date(note.modified)}\ntags: ${tagList(note.tags)}\nlinks to: ${refs(note.links)}\nlinked from: ${refs(note.backlinks)}` +
            (note.unresolved.length ? `\nlinks to missing notes: ${note.unresolved.join("; ")}` : ""),
          "---",
          body,
          ...(hasMore ? [`Truncated: ${note.body.length - nextOffset} more characters. Call again with offset=${nextOffset}.`] : []),
        ].join("\n\n"),
      );
    },
  );

  server.registerTool(
    "related_notes",
    {
      title: "Related notes",
      description: `List notes related to a given note, best first, each with the reasons: wikilinks in either direction, shared tags, and similar content.

Use it to explore around a note you already found, e.g. "what else connects to my Weather Station note?".`,
      inputSchema: z.strictObject({
        note: noteName,
        limit: z.number().int().min(1).max(25).default(8).describe("Maximum number of related notes to return"),
        response_format: responseFormat,
      }),
      annotations: READ_ONLY,
    },
    async ({ note: name, limit, response_format }) => {
      vault.keepFresh();
      const related = await relatedNotes(vault.db, name, limit);
      if (!related) throw notFound(name);
      return reply(response_format, { note: name, count: related.length, related }, () =>
        related.length
          ? [`# Notes related to "${name}"`, ...related.map((n) => `- ${n.title} (${n.path}): ${n.reasons.join("; ")}`)].join("\n")
          : `No related notes found for "${name}".`,
      );
    },
  );

  server.registerTool(
    "recent_notes",
    {
      title: "Recent notes",
      description: `List the most recently modified notes, newest first, with paths and tags.

Use it to see what the user has been working on lately, or to discover valid note paths.
With tags or folder it lists every note that matches, e.g. all notes tagged #book, newest first.`,
      inputSchema: z.strictObject({
        limit: z.number().int().min(1).max(50).default(10).describe("Maximum number of notes to return"),
        offset: z.number().int().min(0).default(0).describe("Number of notes to skip, for pagination"),
        tags: tagsParam,
        folder: folderParam,
        response_format: responseFormat,
      }),
      annotations: READ_ONLY,
    },
    async ({ limit, offset, tags, folder, response_format }) => {
      vault.keepFresh();
      const filter = { tags, folder };
      const { total, notes } = recentNotes(vault.db, limit, offset, filter);
      const nextOffset = offset + notes.length;
      const hasMore = total > nextOffset;
      const data = {
        total,
        count: notes.length,
        offset,
        has_more: hasMore,
        ...(hasMore ? { next_offset: nextOffset } : {}),
        notes: notes.map((n) => ({ path: n.path, title: n.title, modified: new Date(n.modified).toISOString(), tags: n.tags })),
      };
      const scope = describeFilter(filter);
      if (total === 0 && scope) return reply(response_format, data, () => emptyScope(vault.db, filter));
      return reply(response_format, data, () =>
        [
          `# Recently modified notes${scope ? ` ${scope}` : ""} (${offset + 1}-${nextOffset} of ${total})`,
          ...notes.map((n) => `- ${date(n.modified)} ${n.title} (${n.path}) ${n.tags.map((t) => `#${t}`).join(" ")}`.trimEnd()),
          ...(hasMore ? [`More: call again with offset=${nextOffset}.`] : []),
        ].join("\n"),
      );
    },
  );

  return server;
}
