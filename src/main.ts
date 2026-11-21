import { parseArgs } from "node:util";
import { obsidianExcludes } from "./indexer.ts";
import type { SearchMode } from "./search.ts";
import { HL_END, HL_START, parseQuery, search, stats } from "./search.ts";
import { Vault, VERSION } from "./vault.ts";

const HELP = `vaultmind ${VERSION} - local-first search and MCP server for a Markdown/Obsidian vault

Usage: vaultmind <command> [options]

Commands:
  index              Build or update the index (only changed notes are re-read)
  search <query>     Search from the terminal. Narrow it with tag:<tag> and path:<folder>,
                     e.g. vaultmind search "tag:project path:work deadline"
  serve              Start the local web UI (search, related notes, link graph)
  mcp                Run the MCP server on stdio, for Claude Code / Claude Desktop.
                     Read-only; add --allow-write to let Claude create notes and append to them
  ask <question>     Answer a question from your notes with citations (needs ANTHROPIC_API_KEY)

Options:
  --vault <dir>      Vault folder (default: $VAULTMIND_VAULT, else the current directory)
  --db <file>        Index file (default: <vault>/.vaultmind/index.db)
  --no-embed         Keyword search only: never load the local embedding model
  --model <id>       Embedding model on the Hugging Face hub (default: Xenova/all-MiniLM-L6-v2)
  --mode <mode>      search: auto | keyword | semantic (default: auto)
  -n, --limit <n>    search: number of results (default: 10)
  --json             search, ask: print JSON
  -p, --port <n>     serve: port on 127.0.0.1 (default: 4100)
  --allow-write      mcp: add the write_note tool (creates and appends, never overwrites or deletes)
  -h, --help         Show this help
  --version          Show the version
`;

const MODES = ["auto", "keyword", "semantic"];

function integer(value: string, name: string, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`--${name} must be a whole number between ${min} and ${max}`);
  return n;
}

/** Runs the CLI. Returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
  const err = (message: string) => process.stderr.write(`${message}\n`);
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        vault: { type: "string" },
        db: { type: "string" },
        "no-embed": { type: "boolean" },
        model: { type: "string" },
        mode: { type: "string", default: "auto" },
        limit: { type: "string", short: "n", default: "10" },
        json: { type: "boolean" },
        port: { type: "string", short: "p", default: "4100" },
        "allow-write": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean" },
      },
    });
    const [command, ...rest] = positionals;
    if (values.version) {
      console.log(VERSION);
      return 0;
    }
    if (values.help || !command) {
      console.log(HELP);
      return command || values.help ? 0 : 1;
    }
    if (!["index", "search", "serve", "mcp", "ask"].includes(command)) throw new Error(`Unknown command "${command}". Run vaultmind --help.`);
    if (values["allow-write"] && command !== "mcp") throw new Error("--allow-write only applies to the mcp command.");
    if (!MODES.includes(values.mode)) throw new Error(`--mode must be one of: ${MODES.join(", ")}`);

    const vault = new Vault({
      dir: values.vault ?? process.env.VAULTMIND_VAULT ?? process.cwd(),
      dbPath: values.db,
      embed: !values["no-embed"],
      model: values.model,
      log: err,
    });

    if (command === "index") {
      const started = Date.now();
      const changed = vault.sync()!;
      const excludes = obsidianExcludes(vault.dir);
      if (excludes.length) err(`Leaving out notes under Obsidian's "Excluded files": ${excludes.join(", ")}`);
      err(
        `Scanned ${changed.scanned} notes: ${changed.added} added, ${changed.updated} updated, ${changed.removed} removed` +
          (changed.skipped ? `, ${changed.skipped} skipped (unreadable or over 5 MB).` : "."),
      );
      const embedded = await vault.embedPending((done, total) => {
        if (process.stderr.isTTY) process.stderr.write(`\rEmbedding ${done}/${total}`);
      });
      if (embedded && process.stderr.isTTY) process.stderr.write("\n");
      const s = stats(vault.db);
      console.log(
        `${s.notes} notes, ${s.chunks} sections (${s.embedded} with embeddings), ${s.links} links, ${s.tags} tags. ` +
          `Search mode: ${s.embedded ? "hybrid" : "keyword"}. Done in ${((Date.now() - started) / 1000).toFixed(1)}s.`,
      );
      vault.close();
      return 0;
    }

    if (command === "search" || command === "ask") {
      const text = rest.join(" ").trim();
      if (!text) throw new Error(`Usage: vaultmind ${command} <${command === "ask" ? "question" : "query"}>`);
      vault.sync();

      if (command === "ask") {
        const { ask } = await import("./ask.ts"); // the SDKs are heavy: `search` should not load them
        const result = await ask(vault, text);
        if (values.json) console.log(JSON.stringify(result, null, 2));
        else {
          console.log(result.answer);
          for (const source of result.sources) console.log(`\n[${source.n}] ${source.title} (${source.path}:${source.line})\n    "${source.quotes[0]?.trim()}"`);
        }
      } else {
        const { text: words, filter } = parseQuery(text);
        const result = await search(vault.db, words, {
          filter,
          mode: values.mode as SearchMode,
          limit: integer(values.limit, "limit", 1, 100),
          embedder: await vault.queryEmbedder(),
        });
        if (values.json) {
          for (const hit of result.hits) hit.snippet = hit.snippet.replaceAll(HL_START, "").replaceAll(HL_END, ""); // markers are for the terminal and web UI
          console.log(JSON.stringify(result, null, 2));
        } else {
          // Bold titles and matches, dim locations; plain text when piped or when NO_COLOR is set (no-color.org).
          const color = process.stdout.isTTY && !process.env.NO_COLOR;
          const sgr = (code: string, text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
          for (const hit of result.hits) {
            const snippet = hit.snippet.replaceAll(HL_START, color ? "\x1b[1m" : "").replaceAll(HL_END, color ? "\x1b[22m" : "");
            console.log(`${sgr("1", hit.title)}  ${sgr("2", `(${hit.path}:${hit.line})`)}\n  ${hit.heading ? sgr("2", `${hit.heading}: `) : ""}${snippet}\n`);
          }
          if (result.inScope === 0) console.log("No note has that tag or is in that folder.");
          else console.log(`${result.total} note${result.total === 1 ? "" : "s"} (${result.mode} search)`);
        }
      }
      vault.close();
      return 0;
    }

    // Long-running commands: index now, embed in the background, keep picking up edits.
    vault.keepFresh();
    vault.watch();
    if (command === "serve") {
      const port = integer(values.port, "port", 1, 65535);
      await (await import("./web.ts")).startWeb(vault, port);
      err(`vaultmind is serving ${vault.dir}\n  http://127.0.0.1:${port}\nPress Ctrl+C to stop.`);
    } else {
      const [{ serveStdio }, { createServer }] = await Promise.all([import("@modelcontextprotocol/server/stdio"), import("./mcp.ts")]);
      serveStdio(() => createServer(vault, { allowWrite: values["allow-write"] }));
      err(`vaultmind MCP server running on stdio (vault: ${vault.dir}${values["allow-write"] ? ", write_note enabled" : ", read-only"})`);
    }
    return 0;
  } catch (error) {
    err(`Error: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
}
