import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryRecord } from '../src/contracts.js';
import { searchIndex } from '../src/search-index.js';
import { openNativeStore } from '../src/store.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-sprint-59-mode-'));
}

const fallbackRecords: MemoryRecord[] = [
  {
    id: 'project:byomem:root:alpha-lexical',
    scope: 'project',
    identity: { namespace: 'byomem', leafName: 'alpha-lexical', parentContext: 'root' },
    provenance: { source: 'fixtures' },
    content: { text: 'alpha lexical body' },
  },
  {
    id: 'project:byomem:root:alpha-semantic',
    scope: 'project',
    identity: { namespace: 'byomem', leafName: 'alpha-semantic', parentContext: 'root' },
    provenance: { source: 'fixtures' },
    content: { structured: { summary: 'alpha semantic body' } },
  },
];

function fallbackStore(): { list: () => MemoryRecord[] } {
  return { list: () => fallbackRecords };
}

describe('Sprint 59 memory search mode contract', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('accepts bm25, semantic, and hybrid modes on list-backed fallback search', async () => {
    await expect(searchIndex(fallbackStore() as never, { query: 'alpha lexical', mode: 'bm25', limit: 5 })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'project:byomem:root:alpha-lexical' })]),
    );
    await expect(searchIndex(fallbackStore() as never, { query: 'alpha semantic body', mode: 'semantic', limit: 5 })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'project:byomem:root:alpha-semantic' })]),
    );
    await expect(searchIndex(fallbackStore() as never, { query: 'alpha semantic body', mode: 'hybrid', limit: 1 })).resolves.toHaveLength(1);
  });

  it('rejects lexical mode on the public memory search path', async () => {
    await expect(searchIndex(fallbackStore() as never, { query: 'alpha', mode: 'lexical', limit: 5 })).rejects.toThrow(/bm25, semantic, or hybrid/);
  });

  it('honors explicit modes and limits through the sqlite-backed hot index', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const store = openNativeStore({ baseDir: dir, embeddingBaseUrl: 'http://localhost:11434', embeddingModel: 'contract-model', embeddingDimension: 3 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { prompt?: string };
      if (body.prompt?.includes('semantic target') || body.prompt?.includes('semantic query')) return new Response(JSON.stringify({ embedding: [0, 1, 0] }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ embedding: [1, 0, 0] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      const lexical = await store.write({
        scope: 'project',
        identity: { namespace: 'byomem', leafName: 'Lexical Target', parentContext: 'Root' },
        content: { text: 'lexical target body' },
        provenance: { source: 'fixtures' },
      });
      const semantic = await store.write({
        scope: 'project',
        identity: { namespace: 'byomem', leafName: 'Semantic Target', parentContext: 'Root' },
        content: { text: 'semantic target body' },
        provenance: { source: 'fixtures' },
      });

      expect((await searchIndex(store, { query: 'lexical target', mode: 'bm25', limit: 1 })).map((record) => record.id)).toEqual([lexical.id]);
      expect((await searchIndex(store, { query: 'semantic query', mode: 'semantic', limit: 1 })).map((record) => record.id)).toEqual([semantic.id]);
      expect(await searchIndex(store, { query: 'target', mode: 'hybrid', limit: 1 })).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
      store.close();
    }
  });
});
