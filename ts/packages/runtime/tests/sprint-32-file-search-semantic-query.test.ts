import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNativeStore } from '../src/store.js';
import { searchIndex } from '../src/file-search-query.js';
import { openEmbeddingClient } from '../src/embedding-client.js';
import { resolveFileSearchProjectKey } from '../src/file-search-db.js';

type Store = ReturnType<typeof openNativeStore>;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-runtime-sprint-32-query-'));
}

function mockEmbeddings(): { restore: () => void } {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { prompt?: string };
    const prompt = body.prompt ?? '';
    let embedding = [0, 0, 1];
    if (prompt.includes('meaning query') || prompt.includes('alpha target') || prompt.includes('older target body') || prompt.includes('target query')) embedding = [1, 0, 0];
    if (prompt.includes('beta unrelated') || prompt.includes('newer unrelated body')) embedding = [0, 1, 0];
    if (prompt.includes('lexical meaning')) embedding = [0.8, 0.2, 0];
    return new Response(JSON.stringify({ embedding }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = originalFetch; } };
}

describe('Sprint 32 semantic and hybrid file search', () => {
  const dirs: string[] = [];
  const stores: Store[] = [];
  const originalRuntimeBase = process.env.BYOMEM_RUNTIME_BASE_DIR;

  afterEach(() => {
    while (stores.length) stores.pop()?.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    if (originalRuntimeBase === undefined) delete process.env.BYOMEM_RUNTIME_BASE_DIR;
    else process.env.BYOMEM_RUNTIME_BASE_DIR = originalRuntimeBase;
  });

  it('returns semantic-only file hits when the query has no lexical overlap', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const runtimeDir = tempDir();
    dirs.push(runtimeDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    writeFileSync(join(dir, 'alpha.txt'), 'alpha target body\n', 'utf8');
    writeFileSync(join(dir, 'beta.txt'), 'beta unrelated body\n', 'utf8');
    const mock = mockEmbeddings();
    try {
      const store = openNativeStore({ baseDir: dir, fileSearchDbBaseDir: runtimeDir, embeddingBaseUrl: 'http://localhost:11434', fileSearchIncludeTextFiles: true });
      stores.push(store);
      await store.fileSearchDb?.refreshSemanticIndex();

      expect(await searchIndex(store, { query: 'meaning query', mode: 'fts' })).toEqual([]);
      const semantic = await searchIndex(store, { query: 'meaning query', mode: 'semantic', limit: 5 });
      expect(semantic).not.toHaveLength(0);
      expect(semantic.some((hit) => hit.file?.path?.includes('alpha.txt'))).toBe(true);
      expect(semantic.map((hit) => hit.file?.path)).toEqual(expect.arrayContaining([expect.stringContaining('alpha.txt')]));
      expect(semantic.map((hit) => hit.file?.path)).toEqual(expect.arrayContaining([expect.stringContaining('beta.txt')]));
      expect(semantic[0]?.file?.semanticScore).toBeGreaterThan(0.9);
    } finally {
      mock.restore();
    }
  });

  it('semantic search ranks the best cosine match even when it is not the newest embedding row', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const runtimeDir = tempDir();
    dirs.push(runtimeDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    writeFileSync(join(dir, 'older.txt'), 'older target body\n', 'utf8');
    writeFileSync(join(dir, 'newer.txt'), 'newer unrelated body\n', 'utf8');
    const mock = mockEmbeddings();
    try {
      const store = openNativeStore({ baseDir: dir, fileSearchDbBaseDir: runtimeDir, embeddingBaseUrl: 'http://localhost:11434', fileSearchIncludeTextFiles: true });
      stores.push(store);
      await store.fileSearchDb?.refreshSemanticIndex();

      const projectKey = resolveFileSearchProjectKey(dir);
      const rows = store.fileSearchDb?.db.prepare(`
        SELECT e.chunk_id, fr.path
        FROM indexed_chunk_embeddings e
        JOIN indexed_chunks fc ON fc.id = e.chunk_id
        JOIN file_records fr ON fr.id = fc.file_record_id
        WHERE fr.project_key = ?
      `).all(projectKey) as Array<{ chunk_id: string; path: string }>;
      const olderRow = rows?.find((row) => row.path.includes('older.txt'));
      const newerRow = rows?.find((row) => row.path.includes('newer.txt'));
      expect(olderRow).toBeTruthy();
      expect(newerRow).toBeTruthy();
      store.fileSearchDb?.db.prepare(`UPDATE indexed_chunk_embeddings SET updated_at = ? WHERE chunk_id = ?`).run('2000-01-01T00:00:00.000Z', olderRow!.chunk_id);
      store.fileSearchDb?.db.prepare(`UPDATE indexed_chunk_embeddings SET updated_at = ? WHERE chunk_id = ?`).run('2099-01-01T00:00:00.000Z', newerRow!.chunk_id);

      const semantic = await searchIndex(store, { query: 'target query', mode: 'semantic', limit: 1 });
      expect(semantic).toHaveLength(1);
      expect(semantic[0]?.file?.path).toContain('older.txt');
    } finally {
      mock.restore();
    }
  });

  it('scores partial lexical overlap with bm25-style search instead of requiring all tokens', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const runtimeDir = tempDir();
    dirs.push(runtimeDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    writeFileSync(join(dir, 'alpha.txt'), 'alpha body\n', 'utf8');
    writeFileSync(join(dir, 'beta.txt'), 'beta body\n', 'utf8');
    writeFileSync(join(dir, 'both.txt'), 'alpha beta body\n', 'utf8');

    const store = openNativeStore({ baseDir: dir, fileSearchDbBaseDir: runtimeDir, fileSearchIncludeTextFiles: true });
    stores.push(store);
    store.fileSearchDb?.scanAndIndex();

    const lexical = await searchIndex(store, { query: 'alpha beta', mode: 'fts', limit: 5 });
    expect(lexical).toHaveLength(3);
    expect(lexical[0]?.file?.path).toContain('both.txt');
    expect(lexical.map((hit) => hit.file?.path)).toEqual(expect.arrayContaining([
      expect.stringContaining('alpha.txt'),
      expect.stringContaining('beta.txt'),
      expect.stringContaining('both.txt'),
    ]));
  });

  it('hybrid search preserves strong FTS hits while adding semantic recall', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const runtimeDir = tempDir();
    dirs.push(runtimeDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    writeFileSync(join(dir, 'lexical.txt'), 'lexical meaning exact\n', 'utf8');
    writeFileSync(join(dir, 'alpha.txt'), 'alpha target body\n', 'utf8');
    const mock = mockEmbeddings();
    try {
      const store = openNativeStore({ baseDir: dir, fileSearchDbBaseDir: runtimeDir, embeddingBaseUrl: 'http://localhost:11434', fileSearchIncludeTextFiles: true });
      stores.push(store);
      await store.fileSearchDb?.refreshSemanticIndex();

      const hybrid = await searchIndex(store, { query: 'lexical meaning query', mode: 'hybrid', limit: 5 });
      expect(hybrid).not.toHaveLength(0);
      expect(hybrid.some((hit) => hit.file?.path?.includes('lexical.txt'))).toBe(true);
      expect(hybrid.map((hit) => hit.file?.path)).toEqual(expect.arrayContaining([expect.stringContaining('alpha.txt')]));
      expect(new Set(hybrid.map((hit) => hit.id)).size).toBe(hybrid.length);
    } finally {
      mock.restore();
    }
  });

  it('hybrid search preserves strong FTS hits while adding semantic recall', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const runtimeDir = tempDir();
    dirs.push(runtimeDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    writeFileSync(join(dir, 'lexical.txt'), 'lexical meaning exact\n', 'utf8');
    writeFileSync(join(dir, 'alpha.txt'), 'alpha target body\n', 'utf8');
    const mock = mockEmbeddings();
    try {
      const store = openNativeStore({ baseDir: dir, fileSearchDbBaseDir: runtimeDir, embeddingBaseUrl: 'http://localhost:11434', fileSearchIncludeTextFiles: true });
      stores.push(store);
      await store.fileSearchDb?.refreshSemanticIndex();

      const hybrid = await searchIndex(store, { query: 'lexical meaning query', mode: 'hybrid', limit: 5 });
      expect(hybrid).not.toHaveLength(0);
      expect(hybrid.some((hit) => hit.file?.path?.includes('lexical.txt'))).toBe(true);
      expect(hybrid.map((hit) => hit.file?.path)).toEqual(expect.arrayContaining([expect.stringContaining('alpha.txt')]));
      expect(new Set(hybrid.map((hit) => hit.id)).size).toBe(hybrid.length);
    } finally {
      mock.restore();
    }
  });

  it('degrades hybrid search to FTS when semantic embeddings are absent', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const runtimeDir = tempDir();
    dirs.push(runtimeDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    writeFileSync(join(dir, 'lexical.txt'), 'lexical only body\n', 'utf8');
    const store = openNativeStore({ baseDir: dir, fileSearchDbBaseDir: runtimeDir, fileSearchIncludeTextFiles: true });
    stores.push(store);

    const hybrid = await searchIndex(store, { query: 'lexical', mode: 'hybrid', limit: 5 });
    expect(hybrid).toHaveLength(1);
    expect(hybrid[0]?.file?.path).toContain('lexical.txt');
    expect(hybrid[0]?.file?.semanticScore).toBeUndefined();
  });

  it('uses fallback embeddings when no base URL is configured and remote is not required', async () => {
    const client = openEmbeddingClient({ model: 'nomic-embed-text' });
    await expect(client.embed('fallback embedding text')).resolves.toHaveLength(1536);
  });

  it('supports semantic and hybrid file-search after fallback embeddings are indexed', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const runtimeDir = tempDir();
    dirs.push(runtimeDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    writeFileSync(join(dir, 'alpha.txt'), 'alpha target body\n', 'utf8');
    writeFileSync(join(dir, 'beta.txt'), 'beta unrelated body\n', 'utf8');
    const store = openNativeStore({ baseDir: dir, fileSearchDbBaseDir: runtimeDir, fileSearchIncludeTextFiles: true });
    stores.push(store);

    await store.fileSearchDb?.refreshSemanticIndex();

    const semantic = await searchIndex(store, { query: 'alpha target body', mode: 'semantic', limit: 5 });
    expect(semantic).not.toHaveLength(0);
    expect(semantic.some((hit) => hit.file?.path?.includes('alpha.txt'))).toBe(true);

    const hybrid = await searchIndex(store, { query: 'alpha target body', mode: 'hybrid', limit: 5 });
    expect(hybrid).not.toHaveLength(0);
    expect(hybrid.some((hit) => hit.file?.path?.includes('alpha.txt'))).toBe(true);
  });

  it('is explicit that file-search results are project-scoped only', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const runtimeDir = tempDir();
    dirs.push(runtimeDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    writeFileSync(join(dir, 'lexical.txt'), 'lexical only body\n', 'utf8');
    const store = openNativeStore({ baseDir: dir, fileSearchDbBaseDir: runtimeDir, fileSearchIncludeTextFiles: true });
    stores.push(store);

    expect(await searchIndex(store, { query: 'lexical', scope: 'project', mode: 'fts', limit: 5 })).toHaveLength(1);
    expect(await searchIndex(store, { query: 'lexical', scope: 'user', mode: 'fts', limit: 5 })).toEqual([]);
    expect(await searchIndex(store, { query: 'lexical', scope: 'dir', mode: 'hybrid', limit: 5 })).toEqual([]);
  });
});
