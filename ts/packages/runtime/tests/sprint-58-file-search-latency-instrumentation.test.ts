import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFileSearchIndex } from '../src/file-search-index.js';
import { markFileSearchProjectSeen } from '../src/file-search-project-registry.js';
import { openNativeStore } from '../src/store.js';

type Store = ReturnType<typeof openNativeStore>;
type FileDb = NonNullable<Store['fileSearchDb']>;
type EmbeddingCall = {
  model?: string;
  prompt?: string;
  input?: string;
};

function tempDir(prefix = 'byomem-sprint-58-latency-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function seedProject(projectDir: string): void {
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  writeFileSync(join(projectDir, 'src', 'alpha.ts'), 'export function alphaRoute() {\n  return "alpha semantic route";\n}\n', 'utf8');
  writeFileSync(join(projectDir, 'src', 'beta.ts'), 'export function betaRoute() {\n  return "beta semantic route";\n}\n', 'utf8');
  writeFileSync(join(projectDir, 'src', 'gamma.ts'), 'export function gammaRoute() {\n  return "gamma semantic route";\n}\n', 'utf8');
}

function openStore(projectDir: string, options: { semantic?: boolean; runtimeDir?: string } = {}): Store {
  return openNativeStore({
    baseDir: projectDir,
    fileSearchDbBaseDir: options.runtimeDir,
    fileSearchIncludeTextFiles: true,
    fileSearchScanOnOpen: false,
    fileSearchSchedulerEnabled: false,
    fileSearchSemanticEnabled: options.semantic ?? false,
    embeddingBaseUrl: options.semantic ? 'http://localhost:11434' : undefined,
    embeddingModel: options.semantic ? 'nomic-embed-text' : undefined,
    embeddingDimension: options.semantic ? 3 : undefined,
    embeddingRequireRemote: options.semantic ? true : undefined,
  });
}

function mockEmbeddings(): { calls: EmbeddingCall[]; restore: () => void } {
  const calls: EmbeddingCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as EmbeddingCall;
    calls.push(body);
    const text = `${body.prompt ?? ''} ${body.input ?? ''}`.toLowerCase();
    let embedding = [1, 1, 1];
    if (text.includes('alpha')) embedding = [1, 0, 0];
    else if (text.includes('beta')) embedding = [0, 1, 0];
    else if (text.includes('gamma')) embedding = [0, 0, 1];
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

function trackProjectSeenWrites(fileDb: FileDb) {
  const handle = fileDb as { db: Record<string, unknown> };
  const originalDb = handle.db;
  const originalPrepare = (originalDb.prepare as (...args: unknown[]) => unknown).bind(originalDb);
  let updateCount = 0;
  const proxyDb = new Proxy(originalDb, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return ((sql: string, ...args: unknown[]) => {
          const statement = originalPrepare(sql, ...args) as Record<string, unknown>;
          if (
            typeof sql === 'string'
            && sql.includes('UPDATE file_search_projects SET')
            && sql.includes('last_seen_at = ?')
            && sql.includes('last_error = NULL')
          ) {
            return new Proxy(statement, {
              get(statementTarget, statementProp, statementReceiver) {
                if (statementProp === 'run') {
                  return ((...statementArgs: unknown[]) => {
                    updateCount += 1;
                    return Reflect.apply(
                      statementTarget.run as (...runArgs: unknown[]) => unknown,
                      statementTarget,
                      statementArgs,
                    );
                  }) as never;
                }
                return Reflect.get(statementTarget, statementProp, statementReceiver);
              },
            });
          }
          return statement;
        }) as never;
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  handle.db = proxyDb;
  return {
    get count(): number {
      return updateCount;
    },
    restore(): void {
      handle.db = originalDb;
    },
  };
}

describe('Sprint 58 file-search latency instrumentation', () => {
  const dirs: string[] = [];
  const stores: Store[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    while (stores.length) stores.pop()?.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('does not rebuild BM25 row text structures on a repeated warm lexical query', async () => {
    const projectDir = tempDir('byomem-s58-bm25-project-');
    dirs.push(projectDir);
    seedProject(projectDir);

    const store = openStore(projectDir);
    stores.push(store);
    await store.fileSearchDb!.scanAndIndex();

    const index = buildFileSearchIndex(store);
    const snapshot = index.hydrate();
    expect(snapshot).toBeDefined();

    let searchTextReads = 0;
    snapshot!.rows = snapshot!.rows.map((row) => new Proxy(row, {
      get(target, prop, receiver) {
        if (prop === 'searchText') searchTextReads += 1;
        return Reflect.get(target, prop, receiver);
      },
    }));

    const firstHits = await index.search('alpha route', { mode: 'bm25', topK: 3, filterLanguages: ['typescript'] });
    expect(firstHits).not.toHaveLength(0);
    const readsAfterFirstSearch = searchTextReads;
    expect(readsAfterFirstSearch).toBeGreaterThan(0);

    const secondHits = await index.search('alpha route', { mode: 'bm25', topK: 3, filterLanguages: ['typescript'] });
    expect(secondHits).toEqual(firstHits);
    expect(searchTextReads).toBe(readsAfterFirstSearch);
  });

  it('does not rewrite file-search project seen metadata on every repeated warm search', async () => {
    const projectDir = tempDir('byomem-s58-project-seen-project-');
    dirs.push(projectDir);
    seedProject(projectDir);

    const store = openStore(projectDir);
    stores.push(store);
    await store.fileSearchDb!.scanAndIndex();
    markFileSearchProjectSeen(store.fileSearchDb!.db, projectDir, 'manual-status');

    const tracker = trackProjectSeenWrites(store.fileSearchDb!);
    try {
      const index = buildFileSearchIndex(store);
      const firstHits = await index.search('alpha route', { mode: 'bm25', topK: 3 });
      const secondHits = await index.search('alpha route', { mode: 'bm25', topK: 3 });
      const thirdHits = await index.search('alpha route', { mode: 'bm25', topK: 3 });
      expect(firstHits).not.toHaveLength(0);
      expect(secondHits).toEqual(firstHits);
      expect(thirdHits).toEqual(firstHits);
      expect(tracker.count).toBeLessThanOrEqual(1);
    } finally {
      tracker.restore();
    }
  });

  it('hydrates semantic vectors in a packed representation instead of boxed number arrays', async () => {
    const projectDir = tempDir('byomem-s58-semantic-packed-project-');
    dirs.push(projectDir);
    seedProject(projectDir);
    const mock = mockEmbeddings();

    try {
      const store = openStore(projectDir, { semantic: true });
      stores.push(store);
      await store.fileSearchDb!.scanAndIndex();
      await store.fileSearchDb!.refreshSemanticIndex();

      const index = buildFileSearchIndex(store);
      const snapshot = index.hydrate();
      expect(snapshot).toBeDefined();

      const firstVector = snapshot!.vectors.values().next().value as { vector: unknown } | undefined;
      expect(firstVector).toBeDefined();
      expect(ArrayBuffer.isView(firstVector!.vector as ArrayBufferView)).toBe(true);
    } finally {
      mock.restore();
    }
  });

  it('does not perform per-row Map lookups across every hydrated vector during warm semantic search', async () => {
    const projectDir = tempDir('byomem-s58-semantic-scan-project-');
    dirs.push(projectDir);
    seedProject(projectDir);
    const mock = mockEmbeddings();

    try {
      const store = openStore(projectDir, { semantic: true });
      stores.push(store);
      await store.fileSearchDb!.scanAndIndex();
      await store.fileSearchDb!.refreshSemanticIndex();

      const index = buildFileSearchIndex(store);
      const snapshot = index.hydrate();
      expect(snapshot).toBeDefined();

      const originalGet = snapshot!.vectors.get.bind(snapshot!.vectors);
      let vectorGetCount = 0;
      snapshot!.vectors.get = ((key: string) => {
        vectorGetCount += 1;
        return originalGet(key);
      }) as typeof snapshot.vectors.get;

      const hits = await index.search('alpha semantic route', { mode: 'semantic', topK: 1, filterLanguages: ['typescript'] });
      expect(hits).not.toHaveLength(0);
      expect(vectorGetCount).toBe(0);
    } finally {
      mock.restore();
    }
  });

  it('does not repeat full-index filtering passes inside a warm hybrid search', async () => {
    const projectDir = tempDir('byomem-s58-hybrid-filter-project-');
    dirs.push(projectDir);
    seedProject(projectDir);
    const mock = mockEmbeddings();

    try {
      const store = openStore(projectDir, { semantic: true });
      stores.push(store);
      await store.fileSearchDb!.scanAndIndex();
      await store.fileSearchDb!.refreshSemanticIndex();

      const index = buildFileSearchIndex(store);
      const snapshot = index.hydrate();
      expect(snapshot).toBeDefined();

      let filterPassCount = 0;
      const rows = snapshot!.rows;
      const originalFilter = rows.filter.bind(rows);
      rows.filter = ((...args: Parameters<typeof originalFilter>) => {
        filterPassCount += 1;
        return originalFilter(...args);
      }) as typeof rows.filter;

      const hits = await index.search('alpha semantic route', { mode: 'hybrid', topK: 3, filterLanguages: ['typescript'] });
      expect(hits).not.toHaveLength(0);
      expect(filterPassCount).toBeLessThanOrEqual(1);
    } finally {
      mock.restore();
    }
  });
});
