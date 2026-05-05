import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { openFileSearchDb, resolveFileSearchProjectKey } from '../src/file-search-db.js';
import { buildFileSearchIndex, FileSearchIndex } from '../src/file-search-index.js';
import { buildSearchSemanticMetadata, searchIndex as searchFileIndex } from '../src/file-search-query.js';
import { registerOperationsTools } from '../src/mcp/operations-tools.js';
import { openNativeStore } from '../src/store.js';

type Store = ReturnType<typeof openNativeStore>;
type FileSearchPayload = {
  results?: Array<Record<string, unknown>>;
  semantic?: Record<string, unknown>;
  index?: {
    index?: {
      indexedFiles?: number;
      chunkCount?: number;
      baseDir?: string;
      sourceType?: string;
    };
    hotIndex?: {
      state?: string;
      source?: string;
      revision?: number;
      hydrateCount?: number;
      buildCount?: number;
    };
  };
};

type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown> | unknown;
};

type EmbeddingCall = {
  model?: string;
  prompt?: string;
  input?: string;
};

function tempDir(prefix = 'byomem-s58-runtime-surfaces-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function seedProject(projectDir: string): void {
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  writeFileSync(join(projectDir, 'src', 'alpha.ts'), 'export function alphaRoute() {\n  return "alpha semantic route";\n}\n', 'utf8');
  writeFileSync(join(projectDir, 'src', 'beta.ts'), 'export function betaRoute() {\n  return "beta semantic route";\n}\n', 'utf8');
  writeFileSync(join(projectDir, 'src', 'gamma.ts'), 'export function gammaRoute() {\n  return "gamma semantic route";\n}\n', 'utf8');
  writeFileSync(join(projectDir, 'notes.md'), 'alpha route notes for docs only\n', 'utf8');
}

function makeMockPi() {
  const tools: RegisteredTool[] = [];
  return {
    tools,
    api: {
      on() {},
      registerCommand() {},
      registerTool(tool: RegisteredTool) {
        tools.push(tool);
      },
    },
  };
}

function parseLastConsoleJson(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  return JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}')) as Record<string, unknown>;
}

function parseToolJson(result: unknown): Record<string, unknown> {
  return JSON.parse(String((result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '{}')) as Record<string, unknown>;
}

function indexedFileCount(projectDir: string, runtimeDir: string): number {
  const fileDb = openFileSearchDb({
    baseDir: projectDir,
    dbBaseDir: runtimeDir,
    scanOnOpen: false,
    schedulerEnabled: false,
    semanticSearchEnabled: false,
    scannerIncludeTextFiles: true,
  });
  try {
    const row = fileDb.db.prepare('SELECT COUNT(*) AS count FROM indexed_files WHERE project_key = ?').get(resolveFileSearchProjectKey(projectDir)) as { count: number };
    return row.count;
  } finally {
    fileDb.close();
  }
}

function readyEmbeddingCount(projectDir: string, runtimeDir: string): number {
  const fileDb = openFileSearchDb({
    baseDir: projectDir,
    dbBaseDir: runtimeDir,
    scanOnOpen: false,
    schedulerEnabled: false,
    semanticSearchEnabled: true,
    embeddingBaseUrl: 'http://localhost:11434',
    embeddingModel: 'nomic-embed-text',
    embeddingDimension: 3,
    embeddingRequireRemote: true,
    scannerIncludeTextFiles: true,
  });
  try {
    const row = fileDb.db.prepare('SELECT COUNT(*) AS count FROM indexed_chunk_embeddings WHERE project_key = ? AND status = ?').get(resolveFileSearchProjectKey(projectDir), 'ready') as { count: number };
    return row.count;
  } finally {
    fileDb.close();
  }
}

function normalizeResults(results: Array<Record<string, unknown>> | undefined): Array<{ filePath?: string; startLine?: number; endLine?: number; source?: string }> {
  return (results ?? []).map((result) => {
    const chunk = (result.chunk ?? {}) as Record<string, unknown>;
    const file = (result.file ?? {}) as Record<string, unknown>;
    return {
      filePath: typeof chunk.filePath === 'string' ? chunk.filePath : typeof file.path === 'string' ? file.path : undefined,
      startLine: typeof chunk.startLine === 'number' ? chunk.startLine : typeof file.startLine === 'number' ? file.startLine : undefined,
      endLine: typeof chunk.endLine === 'number' ? chunk.endLine : typeof file.endLine === 'number' ? file.endLine : undefined,
      source: typeof result.source === 'string' ? result.source : undefined,
    };
  });
}

function expectHotIndex(payload: Record<string, unknown>, label: string): NonNullable<FileSearchPayload['index']>['hotIndex'] {
  const index = (payload.index ?? {}) as FileSearchPayload['index'];
  expect(index, `${label} index`).toEqual(expect.objectContaining({
    index: expect.objectContaining({
      indexedFiles: expect.any(Number),
      chunkCount: expect.any(Number),
      baseDir: expect.any(String),
      sourceType: 'path',
    }),
    hotIndex: expect.objectContaining({
      state: expect.stringMatching(/^(cold|hydrating|ready|stale|building|failed)$/),
      source: expect.stringMatching(/^(none|sqlite|memory)$/),
      revision: expect.any(Number),
      hydrateCount: expect.any(Number),
      buildCount: expect.any(Number),
    }),
  }));
  return index.hotIndex;
}

function mockEmbeddings(): { calls: EmbeddingCall[]; restore: () => void } {
  const calls: EmbeddingCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as EmbeddingCall;
    calls.push(body);
    const text = `${body.prompt ?? ''} ${body.input ?? ''}`.toLowerCase();
    let embedding = [0.1, 0.1, 0.1];
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

function openSemanticStore(projectDir: string, runtimeDir: string): Store {
  return openNativeStore({
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
}

describe('Sprint 58 runtime surface integration', () => {
  const dirs: string[] = [];
  const stores: Store[] = [];
  const originalRuntimeBase = process.env.BYOMEM_RUNTIME_BASE_DIR;
  const originalEmbeddingBaseUrl = process.env.BYOMEM_EMBEDDING_BASE_URL;
  const originalEmbeddingModel = process.env.BYOMEM_EMBEDDING_MODEL;
  const originalEmbeddingDimension = process.env.BYOMEM_EMBEDDING_DIMENSION;
  const originalIncludeTextFiles = process.env.BYOMEM_FILE_SEARCH_INCLUDE_TEXT_FILES;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    vi.restoreAllMocks();
    while (stores.length) stores.pop()?.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
    if (originalRuntimeBase === undefined) delete process.env.BYOMEM_RUNTIME_BASE_DIR;
    else process.env.BYOMEM_RUNTIME_BASE_DIR = originalRuntimeBase;
    if (originalEmbeddingBaseUrl === undefined) delete process.env.BYOMEM_EMBEDDING_BASE_URL;
    else process.env.BYOMEM_EMBEDDING_BASE_URL = originalEmbeddingBaseUrl;
    if (originalEmbeddingModel === undefined) delete process.env.BYOMEM_EMBEDDING_MODEL;
    else process.env.BYOMEM_EMBEDDING_MODEL = originalEmbeddingModel;
    if (originalEmbeddingDimension === undefined) delete process.env.BYOMEM_EMBEDDING_DIMENSION;
    else process.env.BYOMEM_EMBEDDING_DIMENSION = originalEmbeddingDimension;
    if (originalIncludeTextFiles === undefined) delete process.env.BYOMEM_FILE_SEARCH_INCLUDE_TEXT_FILES;
    else process.env.BYOMEM_FILE_SEARCH_INCLUDE_TEXT_FILES = originalIncludeTextFiles;
    process.exitCode = undefined;
  });

  it('keeps hybrid search on the same hot-index ranking path across direct, CLI, MCP, and Pi surfaces', async () => {
    const runtimeDir = tempDir('byomem-s58-runtime-');
    const projectDir = tempDir('byomem-s58-project-');
    dirs.push(runtimeDir, projectDir);
    seedProject(projectDir);

    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    process.env.BYOMEM_EMBEDDING_BASE_URL = 'http://localhost:11434';
    process.env.BYOMEM_EMBEDDING_MODEL = 'nomic-embed-text';
    process.env.BYOMEM_EMBEDDING_DIMENSION = '3';
    process.env.BYOMEM_FILE_SEARCH_INCLUDE_TEXT_FILES = 'true';

    const fetchMock = mockEmbeddings();
    try {
      const seedStore = openSemanticStore(projectDir, runtimeDir);
      stores.push(seedStore);
      await seedStore.fileSearchDb!.scanAndIndex();
      await seedStore.fileSearchDb!.refreshSemanticIndex();

      const embeddingCountBeforeSearch = readyEmbeddingCount(projectDir, runtimeDir);
      const fetchCallsBeforeSearch = fetchMock.calls.length;
      expect(embeddingCountBeforeSearch).toBeGreaterThan(0);

      const searchSpy = vi.spyOn(FileSearchIndex.prototype, 'search');
      const request = { query: 'alpha semantic route', mode: 'hybrid' as const, limit: 3 };

      const directResults = await searchFileIndex(seedStore, request);
      const directPayload = {
        results: directResults,
        semantic: await buildSearchSemanticMetadata(seedStore, request, directResults),
        index: buildFileSearchIndex(seedStore).stats(),
      };

      const cliSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await main([
        'file-search',
        '--base-dir', projectDir,
        '--semantic-file-search',
        '--embedding-base-url', 'http://localhost:11434',
        '--embedding-model', 'nomic-embed-text',
        '--embedding-dimension', '3',
        '--file-search-include-text-files', 'true',
        '--mode', 'hybrid',
        '--query', request.query,
        '--limit', String(request.limit),
        '--json',
      ]);
      const cliPayload = parseLastConsoleJson(cliSpy);
      cliSpy.mockRestore();

      const runtimeContext: any = {
        runtimeBaseDir: runtimeDir,
        nativeStore: {},
        embeddingConfig: {
          source: 'env',
          embeddingBaseUrl: 'http://localhost:11434',
          embeddingModel: 'nomic-embed-text',
          embeddingDimension: 3,
        },
        fileSearchConfig: {
          source: 'env',
          indexStorageMode: 'disk',
          includeTextFiles: true,
          excludedExtensions: [],
          binaryDetectionEnabled: true,
        },
      };

      const mcpTools: RegisteredTool[] = [];
      registerOperationsTools({
        registerTool(name: string, _meta: unknown, execute: (params: Record<string, unknown>) => Promise<unknown> | unknown) {
          mcpTools.push({
            name,
            execute: (_toolCallId: string, params: Record<string, unknown>) => execute(params),
          });
        },
      } as never, () => runtimeContext);

      const mcpSearchTool = mcpTools.find((tool) => tool.name === 'byomem_file_search');
      expect(mcpSearchTool).toBeDefined();
      const mcpRaw = await mcpSearchTool!.execute('mcp-search', {
        baseDir: projectDir,
        query: request.query,
        mode: request.mode,
        limit: request.limit,
      });
      const mcpPayload = parseToolJson(mcpRaw);
      expect((mcpRaw as { details?: unknown }).details).toMatchObject(mcpPayload);

      const piModule = await import('../src/pi-extension.js');
      const mockPi = makeMockPi();
      piModule.default(mockPi.api as never);
      const piSearchTool = mockPi.tools.find((tool) => tool.name === 'byomem_file_search');
      const piStatusTool = mockPi.tools.find((tool) => tool.name === 'byomem_file_search_status');
      expect(piSearchTool).toBeDefined();
      expect(piStatusTool).toBeDefined();

      const piRaw = await piSearchTool!.execute('pi-search', {
        baseDir: projectDir,
        query: request.query,
        mode: request.mode,
        limit: request.limit,
      });
      const piPayload = parseToolJson(piRaw);
      expect((piRaw as { details?: unknown }).details).toMatchObject(piPayload);

      const piStatus = await piStatusTool!.execute('pi-status', { baseDir: projectDir }) as Record<string, unknown>;

      expect(searchSpy).toHaveBeenCalledTimes(4);
      for (const call of searchSpy.mock.calls) {
        expect(call[0]).toBe(request.query);
        expect(call[1]).toMatchObject({ mode: 'hybrid', topK: 3 });
      }

      const directNormalized = normalizeResults(directPayload.results as Array<Record<string, unknown>>);
      const cliNormalized = normalizeResults((cliPayload as FileSearchPayload).results as Array<Record<string, unknown>>);
      const mcpNormalized = normalizeResults((mcpPayload as FileSearchPayload).results as Array<Record<string, unknown>>);
      const piNormalized = normalizeResults((piPayload as FileSearchPayload).results as Array<Record<string, unknown>>);

      expect(cliNormalized).toEqual(directNormalized);
      expect(mcpNormalized).toEqual(directNormalized);
      expect(piNormalized).toEqual(directNormalized);
      expect(directNormalized[0]).toMatchObject({
        filePath: join(projectDir, 'src', 'alpha.ts'),
        startLine: 1,
        source: 'hybrid',
      });
      expect((directNormalized[0]?.endLine ?? 0)).toBeGreaterThanOrEqual(3);

      const directHotIndex = expectHotIndex(directPayload as Record<string, unknown>, 'direct search');
      const cliHotIndex = expectHotIndex(cliPayload, 'CLI search');
      const mcpHotIndex = expectHotIndex(mcpPayload, 'MCP search');
      const piHotIndex = expectHotIndex(piPayload, 'Pi search');
      const piStatusHotIndex = expectHotIndex(piStatus, 'Pi status');

      expect(cliHotIndex).toEqual(expect.objectContaining({
        state: 'ready',
        source: 'sqlite',
        revision: directHotIndex?.revision,
        hydrateCount: 1,
        buildCount: 1,
      }));
      expect(mcpHotIndex).toEqual(expect.objectContaining({
        state: 'ready',
        source: 'sqlite',
        revision: directHotIndex?.revision,
        hydrateCount: 1,
        buildCount: 1,
      }));
      expect(piHotIndex).toEqual(expect.objectContaining({
        state: 'ready',
        source: 'sqlite',
        revision: directHotIndex?.revision,
        hydrateCount: 1,
        buildCount: 1,
      }));
      expect(piStatusHotIndex).toEqual(expect.objectContaining({
        state: 'ready',
        source: 'sqlite',
        revision: directHotIndex?.revision,
      }));

      for (const payload of [directPayload, cliPayload, mcpPayload, piPayload] as Array<Record<string, unknown>>) {
        expect(payload.semantic).toMatchObject({
          requested: true,
          enabled: true,
          used: true,
          model: 'nomic-embed-text',
          configuredDimension: 3,
          refreshCommand: 'file-search-semantic-refresh',
          refreshTool: 'byomem_file_search_semantic_refresh',
        });
      }

      expect(readyEmbeddingCount(projectDir, runtimeDir)).toBe(embeddingCountBeforeSearch);
      expect(fetchMock.calls.length).toBe(fetchCallsBeforeSearch + 4);
      const searchCalls = fetchMock.calls.slice(fetchCallsBeforeSearch);
      const queryLikeCalls = searchCalls.filter((call) => {
        const text = `${call.prompt ?? ''} ${call.input ?? ''}`.toLowerCase();
        return text.includes(request.query);
      });
      expect(searchCalls).toHaveLength(4);
      expect(queryLikeCalls).toHaveLength(4);
    } finally {
      fetchMock.restore();
    }
  });

  it('keeps status and search side-effect free when no explicit scan has occurred', async () => {
    const runtimeDir = tempDir('byomem-s58-unscanned-runtime-');
    const projectDir = tempDir('byomem-s58-unscanned-project-');
    dirs.push(runtimeDir, projectDir);
    writeFileSync(join(projectDir, 'needle.txt'), 'needle without an explicit scan\n', 'utf8');

    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    process.env.BYOMEM_FILE_SEARCH_INCLUDE_TEXT_FILES = 'true';
    globalThis.fetch = (async () => {
      throw new Error('status and bm25 search must not request embeddings');
    }) as typeof fetch;

    const cliSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['file-search-status', '--base-dir', projectDir, '--json']);
    const cliStatusPayload = parseLastConsoleJson(cliSpy);
    await main([
      'file-search',
      '--base-dir', projectDir,
      '--mode', 'bm25',
      '--query', 'needle',
      '--limit', '5',
      '--file-search-include-text-files', 'true',
      '--json',
    ]);
    const cliSearchPayload = parseLastConsoleJson(cliSpy);
    cliSpy.mockRestore();

    const runtimeContext: any = {
      runtimeBaseDir: runtimeDir,
      nativeStore: {},
      embeddingConfig: { source: 'default' },
      fileSearchConfig: {
        source: 'default',
        indexStorageMode: 'disk',
        includeTextFiles: true,
        excludedExtensions: [],
        binaryDetectionEnabled: true,
      },
    };

    const mcpTools: RegisteredTool[] = [];
    registerOperationsTools({
      registerTool(name: string, _meta: unknown, execute: (params: Record<string, unknown>) => Promise<unknown> | unknown) {
        mcpTools.push({
          name,
          execute: (_toolCallId: string, params: Record<string, unknown>) => execute(params),
        });
      },
    } as never, () => runtimeContext);

    const mcpSearchTool = mcpTools.find((tool) => tool.name === 'byomem_file_search');
    expect(mcpSearchTool).toBeDefined();
    const mcpPayload = parseToolJson(await mcpSearchTool!.execute('mcp-search', {
      baseDir: projectDir,
      query: 'needle',
      mode: 'bm25',
      limit: 5,
    }));

    const piModule = await import('../src/pi-extension.js');
    const mockPi = makeMockPi();
    piModule.default(mockPi.api as never);
    const piStatusTool = mockPi.tools.find((tool) => tool.name === 'byomem_file_search_status');
    const piSearchTool = mockPi.tools.find((tool) => tool.name === 'byomem_file_search');
    expect(piStatusTool).toBeDefined();
    expect(piSearchTool).toBeDefined();

    const piStatusPayload = await piStatusTool!.execute('pi-status', { baseDir: projectDir }) as Record<string, unknown>;
    const piSearchPayload = parseToolJson(await piSearchTool!.execute('pi-search', {
      baseDir: projectDir,
      query: 'needle',
      mode: 'bm25',
      limit: 5,
    }));

    const directStore = openNativeStore({
      baseDir: projectDir,
      fileSearchDbBaseDir: runtimeDir,
      fileSearchIncludeTextFiles: true,
      fileSearchScanOnOpen: false,
      fileSearchSchedulerEnabled: false,
      fileSearchSemanticEnabled: false,
    });
    stores.push(directStore);
    const directResults = await searchFileIndex(directStore, { query: 'needle', mode: 'bm25', limit: 5 });
    const directPayload = {
      results: directResults,
      index: buildFileSearchIndex(directStore).stats(),
    };

    expect(indexedFileCount(projectDir, runtimeDir)).toBe(0);
    expect(readyEmbeddingCount(projectDir, runtimeDir)).toBe(0);

    expect((cliStatusPayload.index as FileSearchPayload['index'])?.index?.indexedFiles).toBe(0);
    expect((cliSearchPayload.results as unknown[] | undefined) ?? []).toEqual([]);
    expect((mcpPayload.results as unknown[] | undefined) ?? []).toEqual([]);
    expect((piSearchPayload.results as unknown[] | undefined) ?? []).toEqual([]);
    expect(directPayload.results).toEqual([]);

    const cliStatusHotIndex = expectHotIndex(cliStatusPayload, 'CLI status');
    const cliSearchHotIndex = expectHotIndex(cliSearchPayload, 'CLI search');
    const mcpSearchHotIndex = expectHotIndex(mcpPayload, 'MCP search');
    const piStatusHotIndex = expectHotIndex(piStatusPayload, 'Pi status');
    const piSearchHotIndex = expectHotIndex(piSearchPayload, 'Pi search');
    const directHotIndex = expectHotIndex(directPayload as Record<string, unknown>, 'direct search');

    for (const hotIndex of [cliStatusHotIndex, cliSearchHotIndex, mcpSearchHotIndex, piStatusHotIndex, piSearchHotIndex, directHotIndex]) {
      expect(hotIndex).toEqual(expect.objectContaining({
        source: 'sqlite',
        revision: 0,
      }));
    }
  });
});
