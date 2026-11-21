export interface Embedder {
  /** Stored with the index: changing it invalidates existing vectors. */
  id: string;
  /** Returns one L2-normalised vector per text. */
  embed(texts: string[]): Promise<Float32Array[]>;
}

export const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";

/**
 * Loads a local sentence-embedding model through transformers.js (ONNX, CPU).
 * The first call downloads the model (about 23 MB for the default) and caches it.
 * Returns null when the optional dependency or the model is unavailable, so callers fall back to keyword search.
 */
export async function loadEmbedder(model = DEFAULT_MODEL, log: (message: string) => void = () => {}): Promise<Embedder | null> {
  try {
    const { pipeline } = await import("@huggingface/transformers");
    const extract = await pipeline("feature-extraction", model, { dtype: "q8" });
    return {
      id: model,
      async embed(texts) {
        const output = await extract(texts, { pooling: "mean", normalize: true });
        const [count, dims] = output.dims as [number, number];
        const data = output.data as Float32Array;
        return Array.from({ length: count }, (_, i) => data.slice(i * dims, (i + 1) * dims));
      },
    };
  } catch (error) {
    log(`Embeddings unavailable (${error instanceof Error ? error.message.split("\n")[0] : error}); using keyword search only.`);
    return null;
  }
}

export function toBlob(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function fromBlob(blob: Uint8Array): Float32Array {
  // Copy: SQLite blobs are not guaranteed to be 4-byte aligned.
  return new Float32Array(blob.slice().buffer);
}

/** Cosine similarity for normalised vectors. */
export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
