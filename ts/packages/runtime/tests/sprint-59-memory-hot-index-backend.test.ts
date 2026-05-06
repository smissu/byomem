import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMemorySearchIndex } from '../src/memory-search-index.js';
import { refreshMemorySemanticIndex } from '../src/memory-search-semantic-refresh.js';
import { searchIndex } from '../src/search-index.js';
import { openNativeStore } from '../src/store.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-sprint-59-hot-'));
}

describe('Sprint 59 memory hot index backend', () => {
  const dirs: string[] = [];
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
  });

  it('hydrates once, reuses warm snapshots, and rehydrates after cross-handle writes and prunes', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const storeA = openNativeStore({ baseDir: dir, embeddingBaseUrl: 'http://localhost:11434', embeddingModel: 'contract-model', embeddingDimension: 3 });
    const storeB = openNativeStore({ baseDir: dir, embeddingBaseUrl: 'http://localhost:11434', embeddingModel: 'contract-model', embeddingDimension: 3 });
    globalThis.fetch = (async () => new Response(JSON.stringify({ embedding: [1, 0, 0] }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    try {
      const alpha = await storeA.write({
        scope: 'project',
        identity: { namespace: 'byomem', leafName: 'Alpha Revision', parentContext: 'Root' },
        content: { text: 'alpha revision body' },
        provenance: { source: 'fixtures' },
      });
      const index = buildMemorySearchIndex(storeA)!;
      expect((await searchIndex(storeA, { query: 'alpha revision', mode: 'bm25', limit: 5 }))[0]?.id).toBe(alpha.id);
      expect(index.hotIndexInfo).toMatchObject({ state: 'ready', hydrateCount: 1, recordCount: 1 });

      await searchIndex(storeA, { query: 'alpha revision', mode: 'bm25', limit: 5 });
      expect(index.hotIndexInfo.hydrateCount).toBe(1);

      const beta = await storeB.write({
        scope: 'project',
        identity: { namespace: 'byomem', leafName: 'Beta Revision', parentContext: 'Root' },
        content: { text: 'beta-only revision body' },
        provenance: { source: 'fixtures' },
      });
      expect(index.hotIndexInfo.state).toBe('stale');
      expect((await searchIndex(storeA, { query: 'beta-only', mode: 'bm25', limit: 5 }))[0]?.id).toBe(beta.id);
      expect(index.hotIndexInfo).toMatchObject({ state: 'ready', hydrateCount: 2, recordCount: 2 });

      expect(storeB.prune(beta.id)?.id).toBe(beta.id);
      expect(index.hotIndexInfo.state).toBe('stale');
      expect(await searchIndex(storeA, { query: 'beta-only', mode: 'bm25', limit: 5 })).toEqual([]);
      expect(index.hotIndexInfo).toMatchObject({ state: 'ready', hydrateCount: 3, recordCount: 1 });
    } finally {
      storeA.close();
      storeB.close();
    }
  });

  it('guards semantic rows by provider/model/dimension/version/content hash and refreshes stale rows', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const store = openNativeStore({ baseDir: dir, embeddingBaseUrl: 'http://localhost:11434', embeddingModel: 'current-model', embeddingDimension: 3 });
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { prompt?: string };
      if (body.prompt?.includes('beta target') || body.prompt?.includes('beta query')) return new Response(JSON.stringify({ embedding: [0, 1, 0] }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ embedding: [1, 0, 0] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      await store.write({
        scope: 'project',
        identity: { namespace: 'byomem', leafName: 'Alpha Target', parentContext: 'Root' },
        content: { text: 'alpha target body' },
        provenance: { source: 'fixtures' },
      });
      const beta = await store.write({
        scope: 'project',
        identity: { namespace: 'byomem', leafName: 'Beta Target', parentContext: 'Root' },
        content: { text: 'beta target body' },
        provenance: { source: 'fixtures' },
      });

      store.sidecar!.db.prepare('UPDATE record_embeddings SET provider_key = ? WHERE record_id = ?').run('remote:http://wrong-provider.test/api/embeddings', beta.id);
      const guarded = await searchIndex(store, { query: 'beta query', mode: 'semantic', limit: 5 });
      expect(guarded.map((record) => record.id)).not.toContain(beta.id);
      expect(store.sidecar!.getEmbeddingDiagnostics()).toMatchObject({ readyRecords: 1, incompatibleRecords: 1, refreshNeeded: true });

      const refresh = await refreshMemorySemanticIndex(store);
      expect(refresh.attempted).toBe(true);
      expect(refresh.diagnostics).toMatchObject({ readyRecords: 2, refreshNeeded: false });
      expect((await searchIndex(store, { query: 'beta query', mode: 'semantic', limit: 1 }))[0]?.id).toBe(beta.id);
    } finally {
      store.close();
    }
  });
});
