import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "../src/embed.ts";

export const FIXTURE = join(import.meta.dirname, "..", "examples", "vault");

/** A private, writable copy of the fixture vault. */
export function tempVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "vaultmind-test-"));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

/** Deterministic stand-in for the real model: hashed bag of words. Texts that share words get similar vectors. */
export const fakeEmbedder: Embedder = {
  id: "fake-hash-512",
  async embed(texts) {
    return texts.map((text) => {
      const vector = new Float32Array(512);
      for (const word of text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []) {
        let hash = 0;
        for (const char of word) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
        vector[hash % 512] += 1;
      }
      const norm = Math.hypot(...vector) || 1;
      return vector.map((x) => x / norm);
    });
  },
};
