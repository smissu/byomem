import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNativeStore } from '../src/store.js';
import { EMBEDDING_TEXT_MAX_CHARS, openSqliteSidecar, sqliteSidecarMutatorKey } from '../src/sqlite-sidecar.js';
import { searchIndex } from '../src/search-index.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-runtime-sidecar-'));
}

describe('sqlite-backed parity slice', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('keeps the public sidecar surface reader-only while guarding internal writes', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const sidecar = openSqliteSidecar({ baseDir: dir });

    expect('syncWrite' in sidecar).toBe(false);
    expect('syncPrune' in sidecar).toBe(false);
    expect(Object.keys(sidecar)).not.toContain(String(sqliteSidecarMutatorKey));
    expect(sidecar.read('project:byomem:root:unauthorized-sidecar')).toBeUndefined();
  });

  it('creates sqlite db artifacts on queue-owned write', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const store = openNativeStore({ baseDir: dir });

    const record = await store.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'SQLite Alpha', parentContext: 'Root' },
      content: { text: 'hello sqlite' },
      provenance: { source: 'fixtures' },
    });

    expect(store.sidecar?.path).toMatch(/byomem-index\.sqlite$/);
    expect(store.sidecar?.read(record.id)?.id).toBe(record.id);
    expect(store.sidecar?.list()).toHaveLength(1);
  });

  it('persists embeddings and fts rows on write', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const store = openNativeStore({ baseDir: dir });

    const record = await store.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'SQLite Beta', parentContext: 'Root' },
      content: { text: 'embedding text' },
      provenance: { source: 'fixtures' },
    });

    const row = store.sidecar?.db.prepare('SELECT * FROM record_embeddings WHERE record_id = ?').get(record.id) as { embedding: Buffer; dimension: number } | undefined;
    const fts = store.sidecar?.db.prepare('SELECT * FROM records_fts WHERE id = ?').get(record.id) as { id: string } | undefined;
    expect(row?.embedding?.length).toBeGreaterThan(0);
    expect(row?.dimension).toBeGreaterThan(0);
    expect(fts?.id).toBe(record.id);
  });

  it('updates and prunes sqlite-backed rows alongside the native record', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const store = openNativeStore({ baseDir: dir });

    const record = await store.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'SQLite Gamma', parentContext: 'Root' },
      content: { text: 'to be replaced' },
      provenance: { source: 'fixtures' },
    });
    await store.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'SQLite Gamma', parentContext: 'Root' },
      content: { text: 'replacement text' },
      provenance: { source: 'fixtures' },
    });
    const countBefore = store.sidecar?.db.prepare('SELECT COUNT(*) AS count FROM record_embeddings WHERE record_id = ?').get(record.id) as { count: number } | undefined;
    expect(countBefore?.count).toBe(1);
    expect(store.prune(record.id)?.id).toBe(record.id);
    const recordsAfter = store.sidecar?.db.prepare('SELECT COUNT(*) AS count FROM records WHERE id = ?').get(record.id) as { count: number } | undefined;
    const embedsAfter = store.sidecar?.db.prepare('SELECT COUNT(*) AS count FROM record_embeddings WHERE record_id = ?').get(record.id) as { count: number } | undefined;
    expect(recordsAfter?.count).toBe(0);
    expect(embedsAfter?.count).toBe(0);
  });

  it('routes search through the sqlite-backed lexical path', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const store = openNativeStore({ baseDir: dir });

    const record = await store.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'SQLite Search', parentContext: 'Root' },
      content: { text: 'lexical sqlite search path' },
      provenance: { source: 'fixtures' },
    });

    const results = await searchIndex(store, { query: 'lexical sqlite search path', scope: 'project', limit: 5 });
    expect(results[0]?.id).toBe(record.id);
    expect(results[0]?.content.text).toContain('lexical sqlite search path');
  });

  it('treats hyphenated tokens as literals in sqlite-backed search', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const store = openNativeStore({ baseDir: dir });

    const record = await store.write({
      scope: 'project',
      identity: { namespace: 'live-verification', leafName: 'byomem-global-tools-smoke', parentContext: 'root' },
      content: { text: 'temporary non-sensitive smoke test record for BYOMem tool verification' },
      provenance: { source: 'fixtures' },
    });

    await expect(searchIndex(store, { query: 'non-sensitive', scope: 'project', limit: 5 })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: record.id })]),
    );
    await expect(searchIndex(store, { query: 'byomem-global-tools-smoke', scope: 'project', limit: 5 })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: record.id })]),
    );
  });

  it('uses remote embeddings and caches them', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { prompt?: string };
      calls.push(body.prompt ?? '');
      return new Response(JSON.stringify({ embedding: [0.25, 0.5, 0.75] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      const store = openNativeStore({ baseDir: dir, embeddingBaseUrl: 'http://localhost:11434', embeddingModel: 'nomic-embed-text' });
      const record = await store.write({
        scope: 'project',
        identity: { namespace: 'byomem', leafName: 'Remote Embed', parentContext: 'Root' },
        content: { text: 'remote embedding body' },
        provenance: { source: 'fixtures' },
      });
      const row = store.sidecar?.db.prepare('SELECT * FROM record_embeddings WHERE record_id = ?').get(record.id) as { embedding: Buffer; dimension: number } | undefined;
      expect(calls.length).toBeGreaterThan(0);
      expect(row?.embedding.length).toBeGreaterThan(0);
      expect(row?.dimension).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('accepts OpenAI-style remote embedding responses', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    try {
      const store = openNativeStore({ baseDir: dir, embeddingBaseUrl: 'http://localhost:11434', embeddingModel: 'text-embedding-3-small' });
      const record = await store.write({
        scope: 'project',
        identity: { namespace: 'byomem', leafName: 'OpenAI Shape', parentContext: 'Root' },
        content: { text: 'openai embedding body' },
        provenance: { source: 'fixtures' },
      });
      const row = store.sidecar?.db.prepare('SELECT * FROM record_embeddings WHERE record_id = ?').get(record.id) as { embedding: Buffer; dimension: number } | undefined;
      expect(row?.embedding.length).toBeGreaterThan(0);
      expect(row?.dimension).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('accepts plural embeddings remote responses', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ embeddings: [[0.4, 0.5, 0.6]] }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    try {
      const store = openNativeStore({ baseDir: dir, embeddingBaseUrl: 'http://localhost:11434', embeddingModel: 'nomic-embed-text' });
      const record = await store.write({
        scope: 'project',
        identity: { namespace: 'byomem', leafName: 'Plural Embeddings Shape', parentContext: 'Root' },
        content: { text: 'plural embeddings body' },
        provenance: { source: 'fixtures' },
      });
      const row = store.sidecar?.db.prepare('SELECT * FROM record_embeddings WHERE record_id = ?').get(record.id) as { embedding: Buffer; dimension: number } | undefined;
      expect(row?.embedding.length).toBeGreaterThan(0);
      expect(row?.dimension).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('truncates oversized record text before requesting embeddings', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const prompts: string[] = [];
    const oversizedText = `hook-prefix ${'x'.repeat(EMBEDDING_TEXT_MAX_CHARS * 2)} hook-suffix`;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { prompt?: string };
      prompts.push(body.prompt ?? '');
      return new Response(JSON.stringify({ embedding: [0.2, 0.4, 0.6] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      const store = openNativeStore({ baseDir: dir, embeddingBaseUrl: 'http://localhost:11434', embeddingModel: 'nomic-embed-text', embeddingRequireRemote: true });
      const record = await store.write({
        scope: 'project',
        identity: { namespace: 'byomem-session', leafName: 'Oversized Session', parentContext: 'Root' },
        content: { text: oversizedText, structured: { transcriptPreview: [oversizedText] } },
        provenance: { source: 'fixtures' },
      });
      const row = store.sidecar?.db.prepare('SELECT * FROM record_embeddings WHERE record_id = ?').get(record.id) as { embedding: Buffer; dimension: number } | undefined;
      const persisted = store.sidecar?.read(record.id);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.length).toBeLessThanOrEqual(EMBEDDING_TEXT_MAX_CHARS);
      expect(prompts[0]).toContain('hook-prefix');
      expect(prompts[0]).toContain('hook-suffix');
      expect(prompts[0]).toContain('[truncated for embedding]');
      expect(persisted?.content.text).toBe(oversizedText);
      expect(row?.embedding.length).toBeGreaterThan(0);
      expect(row?.dimension).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails closed when remote embeddings are required but unavailable', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const store = openNativeStore({ baseDir: dir, embeddingRequireRemote: true });

    await expect(store.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Require Remote', parentContext: 'Root' },
      content: { text: 'must use remote embeddings' },
      provenance: { source: 'fixtures' },
    })).rejects.toThrow(/Remote embedding provider is required/);

    const recordCount = store.sidecar?.db.prepare('SELECT COUNT(*) AS count FROM records').get() as { count: number } | undefined;
    const embeddingCount = store.sidecar?.db.prepare('SELECT COUNT(*) AS count FROM record_embeddings').get() as { count: number } | undefined;
    expect(recordCount?.count).toBe(0);
    expect(embeddingCount?.count).toBe(0);
    expect(store.list()).toHaveLength(0);
  });

  it('returns semantic results for embedding-matched queries', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const store = openNativeStore({ baseDir: dir });

    const record = await store.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Semantic Match', parentContext: 'Root' },
      content: { text: 'semantic vector match body' },
      provenance: { source: 'fixtures' },
    });

    const results = await searchIndex(store, { query: 'semantic vector match body', scope: 'project', mode: 'semantic', limit: 5 });
    expect(results[0]?.id).toBe(record.id);
  });

  it('merges lexical and semantic candidates in hybrid mode with distinct semantic scoring', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const store = openNativeStore({ baseDir: dir, embeddingBaseUrl: 'http://localhost:11434', embeddingModel: 'nomic-embed-text' });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { prompt?: string };
      if (body.prompt?.includes('query signal')) return new Response(JSON.stringify({ embedding: [1, 0, 0] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (body.prompt?.includes('alpha target')) return new Response(JSON.stringify({ embedding: [1, 0, 0] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (body.prompt?.includes('beta target')) return new Response(JSON.stringify({ embedding: [0.9, 0.1, 0] }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ embedding: [1, 0, 0] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      const alpha = await store.write({
        scope: 'project',
        identity: { namespace: 'byomem', leafName: 'Hybrid Alpha', parentContext: 'Root' },
        content: { text: 'alpha target' },
        provenance: { source: 'fixtures' },
      });
      const beta = await store.write({
        scope: 'project',
        identity: { namespace: 'byomem', leafName: 'Hybrid Beta', parentContext: 'Root' },
        content: { text: 'beta target' },
        provenance: { source: 'fixtures' },
      });

      const semanticOnly = await searchIndex(store, { query: 'query signal', scope: 'project', mode: 'semantic', limit: 5 });
      expect(semanticOnly[0]?.id).toBe(alpha.id);
      expect(semanticOnly.map((record) => record.id)).toContain(beta.id);

      const hybrid = await searchIndex(store, { query: 'query signal', scope: 'project', mode: 'hybrid', limit: 5 });
      expect(hybrid[0]?.id).toBe(alpha.id);
      expect(hybrid.map((record) => record.id)).toContain(beta.id);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
