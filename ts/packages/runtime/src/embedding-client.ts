import { createHash } from 'node:crypto';

export interface EmbeddingClientOptions {
  baseUrl?: string;
  model?: string;
  dimension?: number;
  timeoutMs?: number;
}

export interface EmbeddingClient {
  embed(text: string): Promise<number[] | undefined>;
  hashText(text: string): string;
}

function fallbackEmbedding(text: string, dimension = 1536): number[] {
  const seed = createHash('sha256').update(text).digest();
  const vector = new Array<number>(dimension).fill(0);
  for (let i = 0; i < dimension; i += 1) vector[i] = (seed[i % seed.length] ?? 0) / 255;
  return vector;
}

async function remoteEmbedding(url: string, model: string, text: string, timeoutMs?: number): Promise<number[] | undefined> {
  const controller = timeoutMs ? new AbortController() : undefined;
  const timeout = timeoutMs && controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
      signal: controller?.signal,
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as { embedding?: number[] };
    return Array.isArray(payload.embedding) ? payload.embedding : undefined;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function openEmbeddingClient(options: EmbeddingClientOptions = {}): EmbeddingClient {
  return {
    hashText(text: string): string {
      return createHash('sha256').update(text).digest('hex');
    },
    async embed(text: string): Promise<number[] | undefined> {
      if (!text.trim()) return undefined;
      if (!options.baseUrl) return fallbackEmbedding(text, options.dimension);
      try {
        const url = new URL('/api/embeddings', options.baseUrl).toString();
        const vector = await remoteEmbedding(url, options.model ?? 'nomic-embed-text', text, options.timeoutMs);
        return vector ?? fallbackEmbedding(text, options.dimension);
      } catch {
        return fallbackEmbedding(text, options.dimension);
      }
    },
  };
}
