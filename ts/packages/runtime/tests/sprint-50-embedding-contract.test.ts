import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSearchSemanticMetadata } from '../src/file-search-query.js';
import { resolveFileSearchProjectKey } from '../src/file-search-db.js';
import { openNativeStore } from '../src/store.js';

function tempDir(prefix = 'byomem-runtime-sprint-50-contract-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

type RegisteredTool = {
  name: string;
  parameters?: unknown;
  execute: (...args: any[]) => Promise<unknown>;
};

function makeMockPi() {
  const tools: RegisteredTool[] = [];
  const commands: Record<string, { description?: string; handler: (...args: any[]) => Promise<void> }> = {};
  const events: Record<string, Array<(...args: any[]) => any>> = {};
  return {
    tools,
    commands,
    events,
    api: {
      on(name: string, handler: (...args: any[]) => any) {
        events[name] ??= [];
        events[name].push(handler);
      },
      registerTool(tool: RegisteredTool) {
        tools.push(tool);
      },
      registerCommand(name: string, command: { description?: string; handler: (...args: any[]) => Promise<void> }) {
        commands[name] = command;
      },
    },
  };
}

async function loadExtension() {
  vi.resetModules();
  return import('../src/pi-extension.ts');
}

describe('Sprint 50 embedding backend contract', () => {
  const dirs: string[] = [];
  const stores: Array<ReturnType<typeof openNativeStore>> = [];
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unmock('../src/file-search-db.js');
    vi.unstubAllEnvs();
    globalThis.fetch = originalFetch;
    while (stores.length) stores.pop()?.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('uses the Semble model as the default file-search backend when no embedding config is provided', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'default_backend.ts'), 'export const backend = 1;\n', 'utf8');

    const store = openNativeStore({
      baseDir: dir,
      fileSearchScanOnOpen: false,
    });
    stores.push(store);

    store.fileSearchDb?.scanAndIndex();
    const diagnostics = await store.fileSearchDb?.refreshSemanticIndex();

    expect(diagnostics).toMatchObject({
      enabled: true,
      model: 'minishlab/potion-code-16M',
      configuredDimension: 256,
      providerKey: 'local:model2vec:minishlab/potion-code-16M',
      indexedChunks: 1,
      embeddedChunks: 1,
    });
  });

  it('reports the active embedding backend identity in file-search diagnostics', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'identity.txt'), 'embedding contract body\n', 'utf8');

    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ embedding: Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0)) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const store = openNativeStore({
      baseDir: dir,
      embeddingBaseUrl: 'http://localhost:11434',
      embeddingModel: 'nomic-embed-text',
      embeddingDimension: 768,
      embeddingRequireRemote: true,
      fileSearchIncludeTextFiles: true,
      fileSearchScanOnOpen: false,
    });
    stores.push(store);

    store.fileSearchDb?.scanAndIndex();
    const diagnostics = await store.fileSearchDb?.refreshSemanticIndex();

    expect(diagnostics).toMatchObject({
      enabled: true,
      model: 'nomic-embed-text',
      configuredDimension: 768,
      providerKey: 'remote:http://localhost:11434/api/embeddings',
      baseUrl: 'http://localhost:11434',
      requireRemote: true,
      indexedChunks: expect.any(Number),
      embeddedChunks: expect.any(Number),
    });
  });

  it('surfaces backend identity in semantic metadata for search callers', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'metadata.txt'), 'semantic metadata body\n', 'utf8');

    const store = openNativeStore({
      baseDir: dir,
      embeddingBaseUrl: 'http://localhost:11434',
      embeddingModel: 'nomic-embed-text',
      embeddingDimension: 768,
      embeddingRequireRemote: true,
      fileSearchIncludeTextFiles: true,
      fileSearchScanOnOpen: false,
    });
    stores.push(store);

    store.fileSearchDb?.scanAndIndex();
    const metadata = await buildSearchSemanticMetadata(store, { query: 'semantic metadata body', mode: 'semantic', limit: 5 });

    expect(metadata).toMatchObject({
      requested: true,
      enabled: true,
      model: 'nomic-embed-text',
      configuredDimension: 768,
      baseUrl: 'http://localhost:11434',
      providerKey: 'remote:http://localhost:11434/api/embeddings',
      requireRemote: true,
    });
  });

  it('invalidates cached embeddings when the provider key changes', async () => {
    const runtimeDir = tempDir('byomem-runtime-sprint-50-runtime-');
    const projectDir = tempDir('byomem-runtime-sprint-50-project-');
    dirs.push(runtimeDir, projectDir);
    writeFileSync(join(projectDir, 'invalidates.txt'), 'provider identity body\n', 'utf8');

    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ embedding: Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0)) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const storeA = openNativeStore({
      baseDir: projectDir,
      fileSearchDbBaseDir: runtimeDir,
      embeddingBaseUrl: 'http://localhost:11434',
      embeddingModel: 'nomic-embed-text',
      embeddingDimension: 768,
      embeddingRequireRemote: true,
      fileSearchIncludeTextFiles: true,
      fileSearchScanOnOpen: false,
    });
    stores.push(storeA);

    storeA.fileSearchDb?.scanAndIndex();
    await storeA.fileSearchDb?.refreshSemanticIndex();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(storeA.fileSearchDb?.getEmbeddingDiagnostics()).toMatchObject({
      providerKey: 'remote:http://localhost:11434/api/embeddings',
      embeddedChunks: 1,
      state: 'ready',
    });

    const storeB = openNativeStore({
      baseDir: projectDir,
      fileSearchDbBaseDir: runtimeDir,
      embeddingBaseUrl: 'http://127.0.0.1:11434',
      embeddingModel: 'nomic-embed-text',
      embeddingDimension: 768,
      embeddingRequireRemote: true,
      fileSearchIncludeTextFiles: true,
      fileSearchScanOnOpen: false,
    });
    stores.push(storeB);

    expect(storeB.fileSearchDb?.getEmbeddingDiagnostics()).toMatchObject({
      providerKey: 'remote:http://127.0.0.1:11434/api/embeddings',
      embeddedChunks: 0,
      refreshNeededChunks: expect.any(Number),
    });

    await storeB.fileSearchDb?.refreshSemanticIndex();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(storeB.fileSearchDb?.getEmbeddingDiagnostics()).toMatchObject({
      providerKey: 'remote:http://127.0.0.1:11434/api/embeddings',
      embeddedChunks: 1,
      state: 'ready',
    });
  });

  it('fails loudly when the parity backend is unavailable', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'failure.txt'), 'remote failure body\n', 'utf8');

    const fetchSpy = vi.fn(async () => new Response('nope', { status: 500, headers: { 'content-type': 'text/plain' } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const store = openNativeStore({
      baseDir: dir,
      embeddingBaseUrl: 'http://localhost:11434',
      embeddingModel: 'nomic-embed-text',
      embeddingDimension: 768,
      embeddingRequireRemote: true,
      fileSearchIncludeTextFiles: true,
      fileSearchScanOnOpen: false,
    });
    stores.push(store);

    store.fileSearchDb?.scanAndIndex();
    await expect(store.fileSearchDb?.refreshSemanticIndex()).rejects.toThrow(/Remote embedding request returned no embedding for model nomic-embed-text|Remote embedding provider is required/);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('surfaces the active backend identity through the direct Pi semantic refresh tool', async () => {
    const runtimeDir = tempDir('byomem-runtime-sprint-50-pi-runtime-');
    const projectDir = tempDir('byomem-runtime-sprint-50-pi-project-');
    dirs.push(runtimeDir, projectDir);
    const diagnostics = {
      enabled: true,
      state: 'ready' as const,
      projectKey: resolveFileSearchProjectKey(projectDir),
      baseDir: projectDir,
      baseUrl: 'http://localhost:11434',
      providerKey: 'remote:http://localhost:11434/api/embeddings',
      requireRemote: true,
      model: 'nomic-embed-text',
      configuredDimension: 768,
      actualDimensions: [{ dimension: 768, chunks: 1 }],
      indexedChunks: 1,
      embeddedChunks: 1,
      missingChunks: 0,
      incompatibleChunks: 0,
      refreshNeededChunks: 0,
      failedChunks: 0,
      failures: 0,
      fallbacks: 0,
    };

    vi.doMock('../src/file-search-db.js', async () => {
      const actual = await vi.importActual<typeof import('../src/file-search-db.js')>('../src/file-search-db.js');
      return {
        ...actual,
        openFileSearchDb: vi.fn((options: unknown) => {
          const db = actual.openFileSearchDb(options as Parameters<typeof actual.openFileSearchDb>[0]);
          vi.spyOn(db, 'refreshSemanticIndex').mockResolvedValue(diagnostics as never);
          return db;
        }),
      };
    });

    const mod = await loadExtension();
    const mock = makeMockPi();
    mod.default(mock.api as never);

    const refreshTool = mock.tools.find((tool) => tool.name === 'byomem_file_search_semantic_refresh');
    expect(refreshTool).toBeDefined();
    if (!refreshTool) return;

    const result = await refreshTool.execute('direct-refresh', { baseDir: projectDir, limit: 1 }) as {
      details?: { refresh?: Record<string, unknown>; diagnostics?: Record<string, unknown>; embeddings?: Record<string, unknown> };
      refresh?: Record<string, unknown>;
      diagnostics?: Record<string, unknown>;
      embeddings?: Record<string, unknown>;
    };

    expect(result.refresh).toMatchObject({
      tool: 'byomem_file_search_semantic_refresh',
      baseDir: projectDir,
      projectKey: resolveFileSearchProjectKey(projectDir),
      limit: 1,
    });
    expect(result.diagnostics).toMatchObject(diagnostics);
    expect(result.embeddings).toEqual(result.diagnostics);
  });

  it('fails loudly through the direct Pi semantic refresh tool when the parity backend is unavailable', async () => {
    const runtimeDir = tempDir('byomem-runtime-sprint-50-pi-runtime-fail-');
    const projectDir = tempDir('byomem-runtime-sprint-50-pi-project-fail-');
    dirs.push(runtimeDir, projectDir);
    const failure = new Error('Remote embedding request returned no embedding for model nomic-embed-text');

    vi.doMock('../src/file-search-db.js', async () => {
      const actual = await vi.importActual<typeof import('../src/file-search-db.js')>('../src/file-search-db.js');
      return {
        ...actual,
        openFileSearchDb: vi.fn((options: unknown) => {
          const db = actual.openFileSearchDb(options as Parameters<typeof actual.openFileSearchDb>[0]);
          vi.spyOn(db, 'refreshSemanticIndex').mockRejectedValue(failure);
          return db;
        }),
      };
    });

    const mod = await loadExtension();
    const mock = makeMockPi();
    mod.default(mock.api as never);

    const refreshTool = mock.tools.find((tool) => tool.name === 'byomem_file_search_semantic_refresh');
    expect(refreshTool).toBeDefined();
    if (!refreshTool) return;

    await expect(refreshTool.execute('direct-refresh-failure', { baseDir: projectDir, limit: 1 }))
      .rejects.toThrow(/Remote embedding request returned no embedding for model nomic-embed-text/);
  });
});
