import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFileSearchIndex } from '../src/file-search-index.js';
import { resolveFileSearchProjectKey } from '../src/file-search-db.js';
import { openNativeStore } from '../src/store.js';

type Store = ReturnType<typeof openNativeStore>;

type EmbeddingCall = {
  model?: string;
  prompt?: string;
  input?: string;
};

function tempDir(prefix = 'byomem-runtime-sprint-56-hydration-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function seedProject(projectDir: string): { alphaPath: string; betaPath: string } {
  const alphaPath = join(projectDir, 'alpha.txt');
  const betaPath = join(projectDir, 'beta.txt');
  writeFileSync(alphaPath, 'alpha semantic body v1\n', 'utf8');
  writeFileSync(betaPath, 'beta semantic body v1\n', 'utf8');
  return { alphaPath, betaPath };
}

function mockEmbeddings(): { calls: EmbeddingCall[]; restore: () => void } {
  const calls: EmbeddingCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as EmbeddingCall;
    calls.push(body);
    const text = `${body.prompt ?? ''} ${body.input ?? ''}`.toLowerCase();
    let embedding = [0, 0, 1];
    if (text.includes('alpha')) embedding = [1, 0, 0];
    if (text.includes('beta')) embedding = [0, 1, 0];
    return new Response(JSON.stringify({ embedding }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function projectEmbeddingRows(store: Store): Array<{
  path: string;
  chunk_index: number;
  chunk_hash: string;
  model: string;
  provider_key: string;
  configured_dimension: number;
  dimension: number;
  status: string;
  identity_version: string | null;
}> {
  return store.fileSearchDb!.db.prepare(`
    SELECT fr.path, e.chunk_index, e.chunk_hash, e.model, e.provider_key, e.configured_dimension, e.dimension, e.status, e.identity_version
    FROM indexed_chunk_embeddings e
    JOIN indexed_chunks c ON c.id = e.chunk_id
    JOIN file_records fr ON fr.id = c.file_record_id
    WHERE e.project_key = ?
    ORDER BY fr.path
  `).all(resolveFileSearchProjectKey(store.fileSearchProjectBaseDir ?? store.baseDir)) as Array<{
    path: string;
    chunk_index: number;
    chunk_hash: string;
    model: string;
    provider_key: string;
    configured_dimension: number;
    dimension: number;
    status: string;
    identity_version: string | null;
  }>;
}

function projectEmbeddingCacheCount(store: Store): number {
  const row = store.fileSearchDb!.db.prepare(`
    SELECT COUNT(*) AS count
    FROM file_embedding_cache
  `).get() as { count: number };
  return row.count;
}

function closeTrackedStore(stores: Store[], store: Store): void {
  const index = stores.indexOf(store);
  if (index >= 0) stores.splice(index, 1);
  store.close();
}

describe('Sprint 56 hot-index hydration and cache reuse', () => {
  const dirs: string[] = [];
  const stores: Store[] = [];
  const originalRuntimeBase = process.env.BYOMEM_RUNTIME_BASE_DIR;

  afterEach(() => {
    vi.restoreAllMocks();
    while (stores.length) stores.pop()?.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    if (originalRuntimeBase === undefined) delete process.env.BYOMEM_RUNTIME_BASE_DIR;
    else process.env.BYOMEM_RUNTIME_BASE_DIR = originalRuntimeBase;
  });

  it('hydrates persisted embeddings from SQLite after reopen without re-embedding them', async () => {
    const runtimeDir = tempDir('byomem-runtime-sprint-56-hydration-runtime-');
    const projectDir = tempDir('byomem-runtime-sprint-56-hydration-project-');
    dirs.push(runtimeDir, projectDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    const { alphaPath } = seedProject(projectDir);
    const mock = mockEmbeddings();

    try {
      const storeA = openNativeStore({
        baseDir: projectDir,
        fileSearchDbBaseDir: runtimeDir,
        fileSearchIncludeTextFiles: true,
        fileSearchScanOnOpen: false,
        fileSearchSchedulerEnabled: false,
        fileSearchSemanticEnabled: true,
        embeddingBaseUrl: 'http://localhost:11434',
        embeddingModel: 'nomic-embed-text',
        embeddingDimension: 3,
        embeddingRequireRemote: true,
      });
      stores.push(storeA);

      await storeA.fileSearchDb!.scanAndIndex();
      const refreshA = await storeA.fileSearchDb!.refreshSemanticIndex();
      expect(refreshA).toMatchObject({
        state: 'ready',
        embeddedChunks: 2,
        indexedChunks: 2,
      });
      expect(mock.calls).toHaveLength(2);
      expect(projectEmbeddingRows(storeA)).toEqual([
        expect.objectContaining({
          path: alphaPath,
          model: 'nomic-embed-text',
          provider_key: 'remote:http://localhost:11434/api/embeddings',
          configured_dimension: 3,
          dimension: 3,
          status: 'ready',
          identity_version: 'file-search-embedding-v1',
        }),
        expect.objectContaining({
          path: join(projectDir, 'beta.txt'),
          model: 'nomic-embed-text',
          provider_key: 'remote:http://localhost:11434/api/embeddings',
          configured_dimension: 3,
          dimension: 3,
          status: 'ready',
          identity_version: 'file-search-embedding-v1',
        }),
      ]);
      expect(projectEmbeddingCacheCount(storeA)).toBe(2);

      closeTrackedStore(stores, storeA);

      const storeB = openNativeStore({
        baseDir: projectDir,
        fileSearchDbBaseDir: runtimeDir,
        fileSearchIncludeTextFiles: true,
        fileSearchScanOnOpen: false,
        fileSearchSchedulerEnabled: false,
        fileSearchSemanticEnabled: true,
        embeddingBaseUrl: 'http://localhost:11434',
        embeddingModel: 'nomic-embed-text',
        embeddingDimension: 3,
        embeddingRequireRemote: true,
      });
      stores.push(storeB);

      const refreshB = await storeB.fileSearchDb!.refreshSemanticIndex();
      expect(refreshB).toMatchObject({
        state: 'ready',
        embeddedChunks: 2,
        indexedChunks: 2,
      });
      expect(mock.calls).toHaveLength(2);

      const indexB = buildFileSearchIndex(storeB);
      const snapshotB = indexB.hydrate();
      expect(snapshotB).toBeDefined();
      expect(snapshotB!.rows).toHaveLength(2);
      expect(snapshotB!.vectors.size).toBe(2);
      expect(snapshotB!.rows.map((row) => row.filePath)).toEqual([alphaPath, join(projectDir, 'beta.txt')]);
      expect(indexB.stats()).toMatchObject({
        index: {
          indexedFiles: 2,
          chunkCount: 2,
          projectKey: resolveFileSearchProjectKey(projectDir),
        },
        hotIndex: {
          state: 'ready',
          source: 'sqlite',
          chunkCount: 2,
          vectorCount: 2,
          hydrateCount: 1,
          buildCount: 1,
        },
      });
    } finally {
      mock.restore();
    }
  });

  it('does not hydrate stale vectors when the provider identity changes', async () => {
    const runtimeDir = tempDir('byomem-runtime-sprint-56-hydration-runtime-');
    const projectDir = tempDir('byomem-runtime-sprint-56-hydration-project-');
    dirs.push(runtimeDir, projectDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    seedProject(projectDir);
    const mock = mockEmbeddings();

    try {
      const storeA = openNativeStore({
        baseDir: projectDir,
        fileSearchDbBaseDir: runtimeDir,
        fileSearchIncludeTextFiles: true,
        fileSearchScanOnOpen: false,
        fileSearchSchedulerEnabled: false,
        fileSearchSemanticEnabled: true,
        embeddingBaseUrl: 'http://localhost:11434',
        embeddingModel: 'nomic-embed-text',
        embeddingDimension: 3,
        embeddingRequireRemote: true,
      });
      stores.push(storeA);

      await storeA.fileSearchDb!.scanAndIndex();
      await storeA.fileSearchDb!.refreshSemanticIndex();
      expect(mock.calls).toHaveLength(2);
      closeTrackedStore(stores, storeA);

      const incompatibleStore = openNativeStore({
        baseDir: projectDir,
        fileSearchDbBaseDir: runtimeDir,
        fileSearchIncludeTextFiles: true,
        fileSearchScanOnOpen: false,
        fileSearchSchedulerEnabled: false,
        fileSearchSemanticEnabled: true,
        embeddingBaseUrl: 'http://localhost:11434',
        embeddingModel: 'different-model',
        embeddingDimension: 5,
        embeddingRequireRemote: true,
      });
      stores.push(incompatibleStore);

      expect(incompatibleStore.fileSearchDb!.getEmbeddingDiagnostics()).toMatchObject({
        state: 'incompatible',
        embeddedChunks: 0,
        incompatibleChunks: 2,
        refreshNeededChunks: 2,
        model: 'different-model',
        configuredDimension: 5,
      });

      const index = buildFileSearchIndex(incompatibleStore);
      const snapshot = index.hydrate();
      expect(snapshot).toBeDefined();
      expect(snapshot!.rows).toHaveLength(2);
      expect(snapshot!.vectors.size).toBe(0);
      expect(index.stats()).toMatchObject({
        hotIndex: {
          state: 'ready',
          source: 'sqlite',
          chunkCount: 2,
          vectorCount: 0,
        },
      });
      expect(mock.calls).toHaveLength(2);
    } finally {
      mock.restore();
    }
  });

  it('invalidates and rebuilds hot state when chunks change or disappear', async () => {
    const runtimeDir = tempDir('byomem-runtime-sprint-56-hydration-runtime-');
    const projectDir = tempDir('byomem-runtime-sprint-56-hydration-project-');
    dirs.push(runtimeDir, projectDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    const { alphaPath, betaPath } = seedProject(projectDir);
    const mock = mockEmbeddings();

    try {
      const store = openNativeStore({
        baseDir: projectDir,
        fileSearchDbBaseDir: runtimeDir,
        fileSearchIncludeTextFiles: true,
        fileSearchScanOnOpen: false,
        fileSearchSchedulerEnabled: false,
        fileSearchSemanticEnabled: true,
        embeddingBaseUrl: 'http://localhost:11434',
        embeddingModel: 'nomic-embed-text',
        embeddingDimension: 3,
        embeddingRequireRemote: true,
      });
      stores.push(store);

      await store.fileSearchDb!.scanAndIndex();
      await store.fileSearchDb!.refreshSemanticIndex();
      expect(mock.calls).toHaveLength(2);

      const index = buildFileSearchIndex(store);
      const initialSnapshot = index.hydrate();
      expect(initialSnapshot).toBeDefined();
      expect(initialSnapshot!.rows).toHaveLength(2);
      expect(initialSnapshot!.vectors.size).toBe(2);

      writeFileSync(alphaPath, 'alpha semantic body v2\n', 'utf8');
      store.fileSearchDb!.scanAndIndex();
      expect(index.hotIndexInfo).toMatchObject({ state: 'stale' });

      await store.fileSearchDb!.refreshSemanticIndex();
      expect(mock.calls).toHaveLength(3);

      const changedSnapshot = index.hydrate();
      expect(changedSnapshot).toBeDefined();
      expect(changedSnapshot!.rows).toHaveLength(2);
      expect(changedSnapshot!.rows.find((row) => row.filePath === alphaPath)?.content).toContain('v2');
      expect(changedSnapshot!.vectors.size).toBe(2);
      expect(index.hotIndexInfo).toMatchObject({ state: 'ready' });

      rmSync(betaPath);
      store.fileSearchDb!.scanAndIndex();
      expect(index.hotIndexInfo).toMatchObject({ state: 'stale' });

      const deletedSnapshot = index.hydrate();
      expect(deletedSnapshot).toBeDefined();
      expect(deletedSnapshot!.rows).toHaveLength(1);
      expect(deletedSnapshot!.rows[0]?.filePath).toBe(alphaPath);
      expect(deletedSnapshot!.vectors.size).toBe(1);
      expect(mock.calls).toHaveLength(3);
    } finally {
      mock.restore();
    }
  });

  it('invalidates a warmed snapshot when another DB handle mutates the corpus', () => {
    const runtimeDir = tempDir('byomem-runtime-sprint-56-cross-handle-runtime-');
    const projectDir = tempDir('byomem-runtime-sprint-56-cross-handle-project-');
    dirs.push(runtimeDir, projectDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    const { alphaPath } = seedProject(projectDir);

    const storeA = openNativeStore({
      baseDir: projectDir,
      fileSearchDbBaseDir: runtimeDir,
      fileSearchIncludeTextFiles: true,
      fileSearchScanOnOpen: false,
      fileSearchSchedulerEnabled: false,
      fileSearchSemanticEnabled: false,
    });
    stores.push(storeA);
    storeA.fileSearchDb!.scanAndIndex();

    const indexA = buildFileSearchIndex(storeA);
    const initialSnapshot = indexA.hydrate();
    expect(initialSnapshot).toBeDefined();
    expect(initialSnapshot!.rows).toHaveLength(2);
    expect(indexA.hotIndexInfo).toMatchObject({ state: 'ready' });

    const storeB = openNativeStore({
      baseDir: projectDir,
      fileSearchDbBaseDir: runtimeDir,
      fileSearchIncludeTextFiles: true,
      fileSearchScanOnOpen: false,
      fileSearchSchedulerEnabled: false,
      fileSearchSemanticEnabled: false,
    });
    stores.push(storeB);

    writeFileSync(alphaPath, 'alpha semantic body changed by another handle\n', 'utf8');
    storeB.fileSearchDb!.scanAndIndex();

    expect(indexA.hotIndexInfo).toMatchObject({ state: 'stale' });
    const changedSnapshot = indexA.hydrate();
    expect(changedSnapshot).toBeDefined();
    expect(changedSnapshot!.rows.find((row) => row.filePath === alphaPath)?.content).toContain('changed by another handle');
    expect(indexA.hotIndexInfo).toMatchObject({ state: 'ready' });
  });
});
