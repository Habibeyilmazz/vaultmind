import { statSync } from "node:fs";
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
   * in the background, so a query never waits for the model.
   */
  keepFresh(): void {
    const stats = this.sync(30_000);
    if (!this.#embedStarted || (stats && (stats.added || stats.updated))) {
      this.#embedStarted = true;
      this.embedPending().catch((error) => this.#log(`Embedding failed: ${error instanceof Error ? error.message : error}`));
    }
  }

  /** Waits for background embedding to finish. */
  async idle(): Promise<void> {
    await this.#loading;
    await this.#queue;
  }

  close(): void {
    this.db.close();
  }
}
