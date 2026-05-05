import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNativeStore } from '../src/store.js';

type Store = ReturnType<typeof openNativeStore>;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-runtime-sprint-32-schema-'));
}

function mockEmbeddings(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { prompt?: string };
    calls.push(body.prompt ?? '');
    const prompt = body.prompt ?? '';
    const embedding = prompt.includes('beta') ? [0, 1, 0] : [1, 0, 0];
    return new Response(JSON.stringify({ embedding }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

describe('Sprint 32 file-search semantic schema and lifecycle', () => {
  const dirs: string[] = [];
  const stores: Store[] = [];
  const originalRuntimeBase = process.env.BYOMEM_RUNTIME_BASE_DIR;

  beforeEach(() => {
    const runtimeDir = tempDir();
    dirs.push(runtimeDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    while (stores.length) stores.pop()?.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    if (originalRuntimeBase === undefined) delete process.env.BYOMEM_RUNTIME_BASE_DIR;
    else process.env.BYOMEM_RUNTIME_BASE_DIR = originalRuntimeBase;
  });

  it('stores chunk embeddings in the file-search DB, not the memories sidecar', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'alpha.txt'), 'alpha semantic body\n', 'utf8');
    const mock = mockEmbeddings();
    try {
      const store = openNativeStore({ baseDir: dir, embeddingBaseUrl: 'http://localhost:11434', embeddingModel: 'nomic-embed-text' });
      stores.push(store);
      await store.fileSearchDb?.refreshSemanticIndex();

      const rows = store.fileSearchDb?.db.prepare('SELECT * FROM indexed_chunk_embeddings').all() as Array<{ model: string; dimension: number; text_hash: string; updated_at: string }>;
      expect(rows).toEqual([expect.objectContaining({ model: 'nomic-embed-text', dimension: 3, text_hash: expect.any(String), updated_at: expect.any(String) })]);
      expect(() => store.sidecar?.db.prepare('SELECT * FROM indexed_chunk_embeddings').all()).toThrow();
      expect(() => store.fileSearchDb?.db.prepare('SELECT * FROM record_embeddings').all()).toThrow();
      expect(mock.calls).toEqual(expect.arrayContaining(['alpha semantic body']));
    } finally {
      mock.restore();
    }
  });

  it('reuses unchanged chunk embeddings and refreshes changed/deleted chunks', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const filePath = join(dir, 'alpha.txt');
    writeFileSync(filePath, 'alpha semantic body\n', 'utf8');
    const mock = mockEmbeddings();
    try {
      const store = openNativeStore({ baseDir: dir, embeddingBaseUrl: 'http://localhost:11434' });
      stores.push(store);
      await store.fileSearchDb?.refreshSemanticIndex();
      await store.fileSearchDb?.refreshSemanticIndex();
      expect(mock.calls.filter((call) => call.includes('alpha semantic body'))).toHaveLength(1);

      writeFileSync(filePath, 'beta semantic body\n', 'utf8');
      store.fileSearchDb?.scanAndIndex();
      await store.fileSearchDb?.refreshSemanticIndex();
      expect(mock.calls).toEqual(expect.arrayContaining(['beta semantic body']));
      expect(store.fileSearchDb?.db.prepare('SELECT COUNT(*) AS count FROM indexed_chunk_embeddings').get()).toMatchObject({ count: 1 });

      rmSync(filePath);
      store.fileSearchDb?.scanAndIndex();
      expect(store.fileSearchDb?.db.prepare('SELECT COUNT(*) AS count FROM indexed_chunk_embeddings').get()).toMatchObject({ count: 0 });
    } finally {
      mock.restore();
    }
  });

  it('defaults file-search diagnostics to semantic enabled without embedding config', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'alpha.txt'), 'alpha lexical body\n', 'utf8');

    const store = openNativeStore({ baseDir: dir });
    stores.push(store);

    expect(store.fileSearchDb?.getScannerStatus().embeddings).toMatchObject({ enabled: true });
    expect(store.fileSearchDb?.semanticSearchEnabled).toBe(true);
  });

  it('keeps BM25 usable when semantic search is disabled or remote embeddings fail without remote-required mode', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'alpha.txt'), 'alpha lexical body\n', 'utf8');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    try {
      const store = openNativeStore({ baseDir: dir, embeddingBaseUrl: 'http://localhost:11434' });
      stores.push(store);
      expect(store.fileSearchDb?.semanticSearchEnabled).toBe(true);
      await expect(store.fileSearchDb?.refreshSemanticIndex()).resolves.toMatchObject({ enabled: true });
      expect(store.fileSearchDb?.db.prepare('SELECT COUNT(*) AS count FROM indexed_files').get()).toMatchObject({ count: 1 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
