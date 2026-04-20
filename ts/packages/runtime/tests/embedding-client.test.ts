import { afterEach, describe, expect, it } from 'vitest';
import { openEmbeddingClient } from '../src/embedding-client.js';

describe('embedding client', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const originalFetch = globalThis.fetch;

  it.each([
    ['top-level embedding', { embedding: [0.1, 0.2, 0.3] }],
    ['embeddings array', { embeddings: [[0.1, 0.2, 0.3]] }],
    ['openai-compatible data array', { data: [{ embedding: [0.1, 0.2, 0.3] }] }],
  ])('accepts %s response shape', async (_label, payload) => {
    globalThis.fetch = (async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

    const client = openEmbeddingClient({ baseUrl: 'http://localhost:11434', model: 'nomic-embed-text', requireRemote: true });
    await expect(client.embed('remote embedding body')).resolves.toEqual([0.1, 0.2, 0.3]);
  });

  it('still fails in requireRemote mode when no embedding can be extracted', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ nope: [0.1, 0.2, 0.3] }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

    const client = openEmbeddingClient({ baseUrl: 'http://localhost:11434', model: 'nomic-embed-text', requireRemote: true });
    await expect(client.embed('remote embedding body')).rejects.toThrow(/Remote embedding request returned no embedding for model nomic-embed-text/);
  });
});
