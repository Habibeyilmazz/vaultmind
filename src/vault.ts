import { type FSWatcher, statSync, watch } from "node:fs";
import { join, resolve } from "node:path";
import type { Db } from "./db.ts";
import { openDb } from "./db.ts";
import type { Embedder } from "./embed.ts";
import { loadEmbedder } from "./embed.ts";
import type { IndexStats } from "./indexer.ts";
import { embedPending, indexVault } from "./indexer.ts";
import { hasEmbeddings } from "./search.ts";

export interface VaultOptions {
  dir: string;
  /** Index file. Default: <vault>/.vaultmind/index.db */
  dbPath?: string;
  /** false = keyword search only, never load the embedding model. */
  embed?: boolean;
  model?: string;
  /** Diagnostics. Must not write to stdout: the MCP server owns it. */
  log?: (message: string) => void;
  /** Test seam: replaces the transformers.js loader. */
  loader?: () => Promise<Embedder | null>;
}

/** One vault folder plus its index: what the CLI, the MCP server and the web UI all share. */
export const VERSION = "0.1.0";

export class Vault {
  readonly dir: string;
  readonly db: Db;
  /** Set once the embedding model has loaded; null until then, and for good if it cannot load. */
  embedder: Embedder | null = null;
  #options: VaultOptions;
  #loading?: Promise<Embedder | null>;
  #lastSync = 0;
  #embedStarted = false;
  #queue: Promise<unknown> = Promise.resolve();
  #watcher?: FSWatcher;
  #debounce?: NodeJS.Timeout;

  constructor(options: VaultOptions) {
    this.dir = resolve(options.dir);
    if (!statSync(this.dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Vault folder not found: ${this.dir}`);
    this.#options = options;
    this.db = openDb(options.dbPath ?? join(this.dir, ".vaultmind", "index.db"));
  }

  #log(message: string): void {
    this.#options.log?.(message);
  }

  /** Loads the embedding model once. Resolves to null when embeddings are disabled or unavailable. */
  loadEmbedder(): Promise<Embedder | null> {
    if (this.#options.embed === false) return Promise.resolve(null);
    this.#loading ??= (this.#options.loader ?? (() => loadEmbedder(this.#options.model, (m) => this.#log(m))))().then((embedder) => {
      this.embedder = embedder;
      return embedder;
    });
    return this.#loading;
  }

  /**
   * The embedder a query should use. Waits for the model only when the index already holds vectors, so the first
   * query after start-up is not quietly keyword-only. An index without vectors never waits: it answers by keyword.
   */
  async queryEmbedder(): Promise<Embedder | null> {
    return hasEmbeddings(this.db) ? this.loadEmbedder() : this.embedder;
  }

  /** Updates the keyword index from disk, unless that happened less than maxAgeMs ago. */
  sync(maxAgeMs = 0): IndexStats | undefined {
    if (Date.now() - this.#lastSync < maxAgeMs) return undefined;
    const stats = indexVault(this.db, this.dir);
    this.#lastSync = Date.now();
    return stats;
  }

  /** Embeds chunks that have no vector yet. Returns how many; 0 when embeddings are off. */
  async embedPending(onProgress?: (done: number, total: number) => void): Promise<number> {
    const embedder = await this.loadEmbedder();
    if (!embedder) return 0;
    const run = this.#queue.then(() => embedPending(this.db, embedder, onProgress));
    this.#queue = run.catch(() => {});
    return run;
  }

  /**
   * For long-running servers: picks up edits made while running (at most every 30 s) and embeds them
   * in the background, so a query never waits for the model. maxAgeMs 0 re-indexes now.
   */
  keepFresh(maxAgeMs = 30_000): void {
    const stats = this.sync(maxAgeMs);
    if (!this.#embedStarted || (stats && (stats.added || stats.updated))) {
      this.#embedStarted = true;
      this.embedPending().catch((error) => this.#log(`Embedding failed: ${error instanceof Error ? error.message : error}`));
    }
  }

  /**
   * Re-indexes shortly after a file in the vault changes, instead of waiting for the 30 s rescan.
   * Returns false when the platform cannot watch the folder; keepFresh() still rescans then.
   */
  watch(delayMs = 300): boolean {
    if (this.#watcher) return true;
    const rescanIn = (ms: number) => {
      this.#lastSync = 0; // a query arriving before the timer fires re-indexes too
      clearTimeout(this.#debounce);
      this.#debounce = setTimeout(() => {
        try {
          this.keepFresh();
        } catch (error) {
          this.#log(`Re-indexing failed: ${error instanceof Error ? error.message : error}`);
        }
      }, ms).unref();
    };
    try {
      this.#watcher = watch(this.dir, { recursive: true }, (_event, filename) => {
        // Our own index lives in .vaultmind; dot-folders and node_modules are never indexed either.
        // The one exception is Obsidian's settings file: its Excluded files entries decide what is indexed.
        const parts = filename ? String(filename).split(/[\\/]/) : [];
        if (parts.join("/") !== ".obsidian/app.json" && parts.some((part) => part.startsWith(".") || part === "node_modules")) return;
        rescanIn(delayMs);
      });
    } catch (error) {
      this.#log(`Not watching the vault for changes (${error instanceof Error ? error.message : error}); rescanning at most every 30 s instead.`);
      return false;
    }
    this.#watcher.on("error", (error) => {
      this.#log(`Stopped watching the vault for changes (${error.message}); rescanning at most every 30 s instead.`);
      this.#watcher?.close();
      this.#watcher = undefined;
    });
    this.#watcher.unref();
    // macOS starts reporting events a moment after watch() returns, longer on a busy machine: one rescan
    // shortly after start picks up a note written in that gap instead of leaving it for the 30-second rescan.
    rescanIn(Math.max(delayMs, 1000));
    return true;
  }

  /** Waits for background embedding to finish. */
  async idle(): Promise<void> {
    await this.#loading;
    await this.#queue;
  }

  close(): void {
    this.#watcher?.close();
    this.#watcher = undefined;
    clearTimeout(this.#debounce);
    this.db.close();
  }
}
