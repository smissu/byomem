import { createHash } from 'node:crypto';

export interface EmbeddingClientOptions {
  baseUrl?: string;
  model?: string;
  dimension?: number;
  timeoutMs?: number;
  requireRemote?: boolean;
}

export interface EmbeddingClient {
  embed(text: string): Promise<number[] | undefined>;
  hashText(text: string): string;
}

type EmbeddingPayload = {
  embedding?: unknown;
  embeddings?: unknown;
  data?: Array<{ embedding?: unknown }> ;
};

function fallbackEmbedding(text: string, dimension = 1536): number[] {
  const seed = createHash('sha256').update(text).digest();
  const vector = new Array<number>(dimension).fill(0);
  for (let i = 0; i < dimension; i += 1) vector[i] = (seed[i % seed.length] ?? 0) / 255;
  return vector;
}

function asEmbeddingVector(value: unknown): number[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'number') ? value : undefined;
}

function extractEmbedding(payload: EmbeddingPayload): number[] | undefined {
  const directEmbeddings = asEmbeddingVector(payload.embeddings);
  const nestedEmbeddings = Array.isArray(payload.embeddings) ? asEmbeddingVector(payload.embeddings[0]) : undefined;
  return asEmbeddingVector(payload.embedding)
    ?? asEmbeddingVector(payload.data?.[0]?.embedding)
    ?? nestedEmbeddings
    ?? directEmbeddings;
}

async function remoteEmbedding(url: string, model: string, text: string, timeoutMs?: number): Promise<number[] | undefined> {
  const controller = timeoutMs ? new AbortController() : undefined;
  const timeout = timeoutMs && controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: text, input: text }),
      signal: controller?.signal,
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as EmbeddingPayload;
    return extractEmbedding(payload);
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
      if (!options.baseUrl) {
        if (options.requireRemote) throw new Error('Remote embedding provider is required but no embedding base URL is configured');
        return fallbackEmbedding(text, options.dimension);
      }
      try {
        const url = new URL('/api/embeddings', options.baseUrl).toString();
        const vector = await remoteEmbedding(url, options.model ?? 'nomic-embed-text', text, options.timeoutMs);
        if (vector) return vector;
        if (options.requireRemote) throw new Error(`Remote embedding request returned no embedding for model ${options.model ?? 'nomic-embed-text'}`);
        return fallbackEmbedding(text, options.dimension);
      } catch (error) {
        if (options.requireRemote) throw error;
        return fallbackEmbedding(text, options.dimension);
      }
    },
  };
}
