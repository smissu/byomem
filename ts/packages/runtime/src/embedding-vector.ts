export const DEFAULT_EMBEDDING_DIMENSION = 1536;
export const EMBEDDING_TEXT_MAX_CHARS = 4000;
const EMBEDDING_TEXT_TRUNCATION_MARKER = ' …[truncated for embedding]… ';

export function truncateEmbeddingText(text: string, maxChars = EMBEDDING_TEXT_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  const budget = Math.max(0, maxChars - EMBEDDING_TEXT_TRUNCATION_MARKER.length);
  const head = Math.ceil(budget * 0.7);
  const tail = Math.max(0, budget - head);
  return `${text.slice(0, head)}${EMBEDDING_TEXT_TRUNCATION_MARKER}${tail > 0 ? text.slice(-tail) : ''}`;
}

export function encodeEmbedding(embedding: number[]): Buffer {
  const buffer = Buffer.allocUnsafe(embedding.length * 4);
  for (let i = 0; i < embedding.length; i += 1) buffer.writeFloatLE(embedding[i] ?? 0, i * 4);
  return buffer;
}

export function decodeEmbedding(blob: Buffer, dimension: number): number[] {
  const vector = new Array<number>(dimension).fill(0);
  for (let i = 0; i < Math.min(dimension, Math.floor(blob.length / 4)); i += 1) vector[i] = blob.readFloatLE(i * 4);
  return vector;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }
  if (!magA || !magB) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
