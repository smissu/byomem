import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNativeStore } from '../src/store.js';
import { searchIndex } from '../src/search-index.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-runtime-search-parity-'));
}

describe('search parity regression', () => {
  const dirs: string[] = [];
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  async function installEmbeddingMock(mapper: (prompt: string) => number[]): Promise<void> {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { prompt?: string };
      return new Response(JSON.stringify({ embedding: mapper(body.prompt ?? '') }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  }

  it('keeps alpha semantic rerank strong without unrelated spillover', async () => {
    const dir = tempDir();
    dirs.push(dir);
    await installEmbeddingMock((prompt) => prompt.includes('alpha semantic rerank') ? [1, 0, 0] : [0, 1, 0]);

    const store = openNativeStore({ baseDir: dir, embeddingBaseUrl: 'http://localhost:11434' });
    const alpha = await store.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Alpha Semantic', parentContext: 'Root' },
      content: { text: 'alpha semantic rerank' },
      provenance: { source: 'fixtures' },
    });
    await store.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Database Cache', parentContext: 'Root' },
      content: { text: 'database cache' },
      provenance: { source: 'fixtures' },
    });

    const semantic = await searchIndex(store, { query: 'alpha semantic rerank', scope: 'project', mode: 'semantic', limit: 5 });
    expect(semantic[0]?.id).toBe(alpha.id);
    expect(semantic.length).toBe(1);
    expect(semantic.map((record) => record.identity.leafName)).not.toContain('database-cache');
  });

  it('suppresses unrelated beta gamma noise for lexical and hybrid modes', async () => {
    const dir = tempDir();
    dirs.push(dir);
    await installEmbeddingMock((prompt) => prompt.includes('beta gamma') ? [1, 0, 0] : [0, 1, 0]);

    const store = openNativeStore({ baseDir: dir, embeddingBaseUrl: 'http://localhost:11434' });
    const beta = await store.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Beta Gamma', parentContext: 'Root' },
      content: { text: 'beta gamma' },
      provenance: { source: 'fixtures' },
    });
    await store.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Unrelated Delta', parentContext: 'Root' },
      content: { text: 'completely unrelated content' },
      provenance: { source: 'fixtures' },
    });

    const lexical = await searchIndex(store, { query: 'beta gamma', scope: 'project', mode: 'bm25', limit: 5 });
    const hybrid = await searchIndex(store, { query: 'beta gamma', scope: 'project', mode: 'hybrid', limit: 5 });
    expect(lexical[0]?.id).toBe(beta.id);
    expect(lexical.length).toBe(1);
    expect(hybrid[0]?.id).toBe(beta.id);
    expect(hybrid.length).toBe(1);
    expect(hybrid.map((record) => record.identity.leafName)).not.toContain('unrelated-delta');
  });

  it('respects scope filtering and prune visibility for unscoped search', async () => {
    const dir = tempDir();
    dirs.push(dir);
    await installEmbeddingMock((prompt) => prompt.includes('database cache') ? [1, 0, 0] : [0, 1, 0]);

    const store = openNativeStore({ baseDir: dir, embeddingBaseUrl: 'http://localhost:11434' });
    const project = await store.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Database Cache', parentContext: 'Root' },
      content: { text: 'database cache project' },
      provenance: { source: 'fixtures' },
    });
    const dirRecord = await store.write({
      scope: 'dir',
      identity: { namespace: 'byomem', leafName: 'Database Cache', parentContext: 'Root' },
      content: { text: 'database cache dir' },
      provenance: { source: 'fixtures' },
    });

    const unscoped = await searchIndex(store, { query: 'database cache', mode: 'hybrid', limit: 5 });
    expect(unscoped.map((record) => record.id)).toContain(project.id);
    expect(unscoped[0]?.scope).toBe('project');

    store.prune(project.id);
    const afterPrune = await searchIndex(store, { query: 'database cache', mode: 'hybrid', limit: 5 });
    expect(afterPrune.map((record) => record.id)).not.toContain(project.id);
  });
});
