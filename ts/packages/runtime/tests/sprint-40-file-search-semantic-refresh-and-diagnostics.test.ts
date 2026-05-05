import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { main } from '../src/cli.js';
import { openFileSearchDb, resolveFileSearchProjectKey } from '../src/file-search-db.js';
import { searchIndex } from '../src/file-search-query.js';
import { encodeEmbedding } from '../src/embedding-vector.js';
import { openNativeStore } from '../src/store.js';
import { FALLBACK_EMBEDDING_PROVIDER_KEY } from '../src/embedding-client.js';

type Store = ReturnType<typeof openNativeStore>;
type RegisteredTool = {
  name: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  execute: (...args: any[]) => Promise<unknown>;
};
type ChunkRow = {
  id: string;
  project_key: string;
  file_record_id: string;
  chunk_index: number;
  chunk_text: string;
  chunk_hash: string;
};

type SearchOutput = {
  results?: Array<{ file?: { path?: string; project_key?: string } }>;
  semantic?: Record<string, unknown>;
};

function tempDir(prefix = 'byomem-runtime-sprint-40-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function remoteProviderKey(baseUrl: string): string {
  return `remote:${new URL('/api/embeddings', baseUrl).toString()}`;
}

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

function parseLastLog(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  return JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}')) as Record<string, unknown>;
}

function parseLastError(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  return JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}')) as Record<string, unknown>;
}

function projectChunks(db: BetterSqliteDatabase, projectKey: string): ChunkRow[] {
  return db.prepare(`
    SELECT id, project_key, file_record_id, chunk_index, chunk_text, chunk_hash
    FROM indexed_chunks
    WHERE project_key = ?
    ORDER BY file_record_id, chunk_index
  `).all(projectKey) as ChunkRow[];
}

function tableColumns(db: BetterSqliteDatabase, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name));
}

function seedChunkEmbedding(
  db: BetterSqliteDatabase,
  chunk: ChunkRow,
  options: {
    model: string;
    configuredDimension: number;
    dimension: number;
    vector?: number[];
    status?: 'ready' | 'failed';
    error?: string | null;
    providerKey?: string;
  },
): void {
  const now = new Date().toISOString();
  const columns = tableColumns(db, 'indexed_chunk_embeddings');
  const status = options.status ?? 'ready';
  const vector = options.vector ?? new Array(options.dimension).fill(0);
  const row: Record<string, unknown> = {
    chunk_id: chunk.id,
    project_key: chunk.project_key,
    file_record_id: chunk.file_record_id,
    chunk_index: chunk.chunk_index,
    chunk_hash: chunk.chunk_hash,
    text_hash: sha256(chunk.chunk_text),
    model: options.model,
    configured_dimension: options.configuredDimension,
    embedding: status === 'failed' ? Buffer.alloc(0) : encodeEmbedding(vector),
    dimension: options.dimension,
    status,
    error: options.error ?? null,
    created_at: now,
    updated_at: now,
  };

  if (columns.has('provider_key')) row.provider_key = options.providerKey ?? FALLBACK_EMBEDDING_PROVIDER_KEY;
  if (columns.has('embedding_provider_key')) row.embedding_provider_key = options.providerKey ?? FALLBACK_EMBEDDING_PROVIDER_KEY;
  if (columns.has('effective_dimension')) row.effective_dimension = options.dimension;
  if (columns.has('identity_version')) row.identity_version = 'file-search-embedding-v1';
  if (columns.has('cache_version')) row.cache_version = 'file-search-embedding-v1';

  const insertColumns = Object.keys(row).filter((column) => columns.has(column));
  const placeholders = insertColumns.map(() => '?').join(', ');
  db.prepare(`INSERT OR REPLACE INTO indexed_chunk_embeddings (${insertColumns.join(', ')}) VALUES (${placeholders})`)
    .run(...insertColumns.map((column) => row[column]));
}

function embeddingCount(db: BetterSqliteDatabase, projectKey: string): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM indexed_chunk_embeddings WHERE project_key = ?').get(projectKey) as { count: number }).count;
}

function closeTrackedStore(stores: Store[], store: Store): void {
  const index = stores.indexOf(store);
  if (index >= 0) stores.splice(index, 1);
  store.close();
}

describe('Sprint 40 file-search semantic refresh and diagnostics RED contracts', () => {
  const dirs: string[] = [];
  const stores: Store[] = [];
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    BYOMEM_RUNTIME_BASE_DIR: process.env.BYOMEM_RUNTIME_BASE_DIR,
    BYOMEM_CONFIG_PATH: process.env.BYOMEM_CONFIG_PATH,
    BYOMEM_EMBEDDING_BASE_URL: process.env.BYOMEM_EMBEDDING_BASE_URL,
    BYOMEM_EMBEDDING_MODEL: process.env.BYOMEM_EMBEDDING_MODEL,
    BYOMEM_EMBEDDING_DIMENSION: process.env.BYOMEM_EMBEDDING_DIMENSION,
    BYOMEM_EMBEDDING_TIMEOUT_MS: process.env.BYOMEM_EMBEDDING_TIMEOUT_MS,
  };

  afterEach(() => {
    while (stores.length) stores.pop()?.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.exitCode = undefined;
  });

  it('diagnostics are project-scoped and expose exact fields/counts including dimensions, failures alias, state, and refreshNeededChunks', () => {
    const runtimeDir = tempDir();
    const projectA = tempDir('byomem-runtime-sprint-40-diagnostics-a-');
    const projectB = tempDir('byomem-runtime-sprint-40-diagnostics-b-');
    dirs.push(runtimeDir, projectA, projectB);
    writeFileSync(join(projectA, 'mixed.txt'), 'ready compatible\nready wrong dimension\nfailed embedding\nmissing embedding\n', 'utf8');
    writeFileSync(join(projectB, 'other.txt'), 'other project compatible\n', 'utf8');

    const storeA = openNativeStore({ fileSearchIncludeTextFiles: true, baseDir: projectA, fileSearchDbBaseDir: runtimeDir, embeddingModel: 'contract-model', embeddingDimension: 3 });
    const storeB = openNativeStore({ fileSearchIncludeTextFiles: true, baseDir: projectB, fileSearchDbBaseDir: runtimeDir, embeddingModel: 'contract-model', embeddingDimension: 3 });
    stores.push(storeA, storeB);
    const projectKeyA = resolveFileSearchProjectKey(projectA);
    const projectKeyB = resolveFileSearchProjectKey(projectB);
    const chunksA = projectChunks(storeA.fileSearchDb!.db, projectKeyA);
    const chunksB = projectChunks(storeA.fileSearchDb!.db, projectKeyB);
    expect(chunksA).toHaveLength(4);
    expect(chunksB).toHaveLength(1);

    seedChunkEmbedding(storeA.fileSearchDb!.db, chunksA[0]!, { model: 'contract-model', configuredDimension: 3, dimension: 3, vector: [1, 0, 0] });
    seedChunkEmbedding(storeA.fileSearchDb!.db, chunksA[1]!, { model: 'contract-model', configuredDimension: 3, dimension: 5, vector: [1, 0, 0, 0, 0] });
    seedChunkEmbedding(storeA.fileSearchDb!.db, chunksA[2]!, { model: 'contract-model', configuredDimension: 3, dimension: 0, status: 'failed', error: 'remote boom' });
    seedChunkEmbedding(storeA.fileSearchDb!.db, chunksB[0]!, { model: 'contract-model', configuredDimension: 3, dimension: 3, vector: [0, 1, 0] });

    const diagnostics = storeA.fileSearchDb!.getEmbeddingDiagnostics() as unknown as Record<string, unknown>;

    expect(Object.keys(diagnostics).sort()).toEqual([
      'actualDimensions',
      'baseDir',
      'baseUrl',
      'configuredDimension',
      'embeddedChunks',
      'enabled',
      'failedChunks',
      'failures',
      'fallbacks',
      'incompatibleChunks',
      'indexedChunks',
      'lastError',
      'missingChunks',
      'model',
      'projectKey',
      'providerKey',
      'refreshNeededChunks',
      'requireRemote',
      'state',
    ].sort());
    expect(diagnostics).toEqual({
      enabled: true,
      state: 'incompatible',
      projectKey: projectKeyA,
      baseDir: resolve(projectA),
      baseUrl: undefined,
      providerKey: 'remote:http://localhost:11434/api/embeddings',
      requireRemote: false,
      model: 'contract-model',
      configuredDimension: 3,
      actualDimensions: [
        { dimension: 3, chunks: 1 },
        { dimension: 5, chunks: 1 },
      ],
      indexedChunks: 4,
      embeddedChunks: 1,
      missingChunks: 1,
      incompatibleChunks: 1,
      refreshNeededChunks: 3,
      failedChunks: 1,
      failures: 1,
      fallbacks: 0,
      lastError: 'remote boom',
    });
  });

  it('semantic refresh is project-scoped and does not affect same-basename sibling projects', async () => {
    const runtimeDir = tempDir();
    const parentA = tempDir('byomem-runtime-sprint-40-same-a-');
    const parentB = tempDir('byomem-runtime-sprint-40-same-b-');
    const projectA = join(parentA, 'same-project');
    const projectB = join(parentB, 'same-project');
    dirs.push(runtimeDir, parentA, parentB);
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    writeFileSync(join(projectA, 'same.txt'), 'alpha project body\n', 'utf8');
    writeFileSync(join(projectB, 'same.txt'), 'beta project body\n', 'utf8');
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ embedding: [1, 0, 0] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const storeA = openNativeStore({ fileSearchIncludeTextFiles: true, baseDir: projectA, fileSearchDbBaseDir: runtimeDir, embeddingBaseUrl: 'http://localhost:11434', embeddingModel: 'same-model', embeddingDimension: 3 });
    const storeB = openNativeStore({ fileSearchIncludeTextFiles: true, baseDir: projectB, fileSearchDbBaseDir: runtimeDir, embeddingBaseUrl: 'http://localhost:11434', embeddingModel: 'same-model', embeddingDimension: 3 });
    stores.push(storeA, storeB);
    const projectKeyA = resolveFileSearchProjectKey(projectA);
    const projectKeyB = resolveFileSearchProjectKey(projectB);

    await storeA.fileSearchDb!.refreshSemanticIndex({ limit: 10 });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(embeddingCount(storeA.fileSearchDb!.db, projectKeyA)).toBe(1);
    expect(embeddingCount(storeA.fileSearchDb!.db, projectKeyB)).toBe(0);
  });

  it('semantic refresh runs chunk embeddings concurrently within the batch window', async () => {
    const runtimeDir = tempDir();
    const projectDir = tempDir('byomem-runtime-sprint-40-refresh-parallel-');
    dirs.push(runtimeDir, projectDir);
    writeFileSync(join(projectDir, 'parallel.txt'), [
      'parallel line one',
      'parallel line two',
      'parallel line three',
    ].join('\n'), 'utf8');

    let inFlight = 0;
    let maxInFlight = 0;
    const fetchSpy = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return new Response(JSON.stringify({ embedding: [1, 0, 0] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      } finally {
        inFlight -= 1;
      }
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const store = openNativeStore({
      fileSearchIncludeTextFiles: true,
      baseDir: projectDir,
      fileSearchDbBaseDir: runtimeDir,
      embeddingBaseUrl: 'http://localhost:11434',
      embeddingModel: 'parallel-model',
      embeddingDimension: 3,
      fileSearchEmbeddingConcurrency: 2,
      fileSearchScanOnOpen: false,
    });

    store.fileSearchDb!.scanAndIndex();

    await store.fileSearchDb!.refreshSemanticIndex({ limit: 3 });

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(embeddingCount(store.fileSearchDb!.db, resolveFileSearchProjectKey(projectDir))).toBe(3);
  });

  it('semantic refresh respects a configured concurrency of 1', async () => {
    const runtimeDir = tempDir();
    const projectDir = tempDir('byomem-runtime-sprint-40-refresh-serial-');
    dirs.push(runtimeDir, projectDir);
    writeFileSync(join(projectDir, 'serial.txt'), [
      'serial line one',
      'serial line two',
      'serial line three',
    ].join('\n'), 'utf8');

    let inFlight = 0;
    let maxInFlight = 0;
    const fetchSpy = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return new Response(JSON.stringify({ embedding: [1, 0, 0] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      } finally {
        inFlight -= 1;
      }
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const store = openNativeStore({
      fileSearchIncludeTextFiles: true,
      baseDir: projectDir,
      fileSearchDbBaseDir: runtimeDir,
      embeddingModel: 'serial-model',
      embeddingDimension: 3,
      fileSearchEmbeddingConcurrency: 1,
      fileSearchScanOnOpen: false,
    });

    store.fileSearchDb!.scanAndIndex();

    await store.fileSearchDb!.refreshSemanticIndex({ limit: 3 });

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBe(1);
    expect(embeddingCount(store.fileSearchDb!.db, resolveFileSearchProjectKey(projectDir))).toBe(3);
  });

  it('CLI hybrid search does not hidden-refresh and returns semantic refresh-needed metadata', async () => {
    const runtimeDir = tempDir();
    const projectDir = tempDir('byomem-runtime-sprint-40-cli-no-hidden-');
    dirs.push(runtimeDir, projectDir);
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', runtimeDir);
    writeFileSync(join(projectDir, 'lexical.txt'), 'lexical alpha body\n', 'utf8');
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ embedding: [1, 0, 0] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main([
      'file-search',
      '--base-dir', projectDir,
      '--file-search-include-text-files', 'true',
      '--mode', 'hybrid',
      '--query', 'lexical',
      '--limit', '5',
      '--embedding-base-url', 'http://localhost:11434',
      '--embedding-model', 'cli-model',
      '--embedding-dimension', '3',
      '--json',
    ]);

    const output = parseLastLog(logSpy) as SearchOutput;
    expect(process.exitCode).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(output.results?.map((hit) => hit.file?.path)).toEqual([expect.stringContaining('lexical.txt')]);
    expect(output.semantic).toMatchObject({
      requested: true,
      enabled: true,
      used: false,
      state: 'refresh-needed',
      refreshNeeded: true,
      incompatible: false,
      projectKey: resolveFileSearchProjectKey(projectDir),
      model: 'cli-model',
      configuredDimension: 3,
      actualDimensions: [],
      embeddedChunks: 0,
      missingChunks: 1,
      incompatibleChunks: 0,
      refreshNeededChunks: 1,
      failedChunks: 0,
      failures: 0,
      refreshCommand: 'file-search-semantic-refresh',
      refreshTool: 'byomem_file_search_semantic_refresh',
    });
  });

  it('CLI file-search-semantic-refresh validates embedding dimension before opening file-search', async () => {
    const runtimeDir = tempDir();
    const projectDir = tempDir('byomem-runtime-sprint-40-cli-invalid-dimension-');
    dirs.push(runtimeDir, projectDir);
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', runtimeDir);
    writeFileSync(join(projectDir, 'alpha.txt'), 'alpha body\n', 'utf8');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await main(['file-search-semantic-refresh', '--base-dir', projectDir, '--embedding-dimension', '0', '--json']);

    expect(parseLastError(errSpy)).toMatchObject({
      error: '--embedding-dimension must be a positive integer',
      command: 'file-search-semantic-refresh',
    });
    expect(existsSync(join(runtimeDir, 'byomem-file-search.sqlite'))).toBe(false);
  });

  it('CLI file-search-semantic-refresh exists, opens with scanOnOpen false, and refreshes only the requested project', async () => {
    const runtimeDir = tempDir();
    const parentA = tempDir('byomem-runtime-sprint-40-cli-refresh-a-');
    const parentB = tempDir('byomem-runtime-sprint-40-cli-refresh-b-');
    const projectA = join(parentA, 'same-project');
    const projectB = join(parentB, 'same-project');
    dirs.push(runtimeDir, parentA, parentB);
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', runtimeDir);
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    writeFileSync(join(projectA, 'indexed.txt'), 'alpha indexed body\n', 'utf8');
    writeFileSync(join(projectB, 'indexed.txt'), 'beta indexed body\n', 'utf8');
    const scanA = openFileSearchDb({ scannerIncludeTextFiles: true, baseDir: projectA, dbBaseDir: runtimeDir, semanticSearchEnabled: false });
    scanA.close();
    const scanB = openFileSearchDb({ scannerIncludeTextFiles: true, baseDir: projectB, dbBaseDir: runtimeDir, semanticSearchEnabled: false });
    scanB.close();
    writeFileSync(join(projectA, 'not-scanned-by-refresh.txt'), 'refresh command must not scan this file\n', 'utf8');
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ embedding: [1, 0, 0] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main([
      'file-search-semantic-refresh',
      '--base-dir', projectA,
      '--limit', '10',
      '--embedding-base-url', 'http://localhost:11434',
      '--embedding-model', 'refresh-model',
      '--embedding-dimension', '3',
      '--json',
    ]);

    const output = parseLastLog(logSpy);
    const projectKeyA = resolveFileSearchProjectKey(projectA);
    const projectKeyB = resolveFileSearchProjectKey(projectB);
    expect(process.exitCode).toBeUndefined();
    expect(output).toMatchObject({
      refresh: {
        command: 'file-search-semantic-refresh',
        baseDir: resolve(projectA),
        projectKey: projectKeyA,
        limit: 10,
      },
      diagnostics: expect.objectContaining({ projectKey: projectKeyA, baseDir: resolve(projectA) }),
      embeddings: expect.objectContaining({ projectKey: projectKeyA, baseDir: resolve(projectA) }),
    });
    const verifyDb = openFileSearchDb({ scannerIncludeTextFiles: true, baseDir: projectA, dbBaseDir: runtimeDir, scanOnOpen: false, schedulerEnabled: false });
    try {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(embeddingCount(verifyDb.db, projectKeyA)).toBe(1);
      expect(embeddingCount(verifyDb.db, projectKeyB)).toBe(0);
      expect(projectChunks(verifyDb.db, projectKeyA).map((chunk) => chunk.chunk_text)).not.toContain('refresh command must not scan this file');
    } finally {
      verifyDb.close();
    }
  });

  it('Pi runtime status exposes embeddingDimension with env-over-YAML precedence and direct search semantic metadata uses it', async () => {
    const runtimeDir = tempDir();
    const projectDir = tempDir('byomem-runtime-sprint-40-pi-config-');
    const configPath = join(runtimeDir, 'config.yaml');
    dirs.push(runtimeDir, projectDir);
    writeFileSync(configPath, [
      'embeddings:',
      '  base_url: http://localhost:11434',
      '  model: yaml-model',
      '  dimension: 11',
      '  request_timeout: 22',
    ].join('\n') + '\n', 'utf8');
    writeFileSync(join(projectDir, 'alpha.txt'), 'alpha direct body\n', 'utf8');
    const scanDb = openFileSearchDb({ scannerIncludeTextFiles: true, baseDir: projectDir, dbBaseDir: runtimeDir });
    scanDb.close();
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', runtimeDir);
    vi.stubEnv('BYOMEM_CONFIG_PATH', configPath);
    vi.stubEnv('BYOMEM_EMBEDDING_DIMENSION', '13');
    const mod = await loadExtension();

    expect(mod.byomem_runtime_status()).toMatchObject({
      embeddingBaseUrl: 'http://localhost:11434',
      embeddingModel: 'yaml-model',
      embeddingTimeoutMs: 22,
      embeddingDimension: 13,
    });

    const mock = makeMockPi();
    mod.default(mock.api as never);
    const searchTool = mock.tools.find((tool) => tool.name === 'byomem_file_search')!;
    const result = await searchTool.execute('semantic-metadata', { query: 'alpha', baseDir: projectDir, mode: 'hybrid', limit: 1 }) as { details?: { semantic?: Record<string, unknown> } };
    expect(result.details?.semantic).toMatchObject({
      requested: true,
      enabled: true,
      state: 'refresh-needed',
      projectKey: resolveFileSearchProjectKey(projectDir),
      model: 'yaml-model',
      configuredDimension: 13,
      refreshTool: 'byomem_file_search_semantic_refresh',
    });
  });

  it('Pi rejects invalid embedding dimensions from env and YAML config', async () => {
    const runtimeDir = tempDir();
    const configPath = join(runtimeDir, 'config.yaml');
    dirs.push(runtimeDir);
    writeFileSync(configPath, ['embeddings:', '  dimension: nope'].join('\n') + '\n', 'utf8');
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', runtimeDir);
    vi.stubEnv('BYOMEM_CONFIG_PATH', configPath);
    await expect(loadExtension()).rejects.toThrow(/embedding dimension must be a positive integer/);

    vi.resetModules();
    writeFileSync(configPath, ['embeddings:', '  dimension: 7'].join('\n') + '\n', 'utf8');
    vi.stubEnv('BYOMEM_EMBEDDING_DIMENSION', '0');
    await expect(loadExtension()).rejects.toThrow(/embedding dimension must be a positive integer/);
  });

  it('Pi registers byomem_file_search_semantic_refresh with strict schema and input validation', async () => {
    const runtimeDir = tempDir();
    dirs.push(runtimeDir);
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', runtimeDir);
    const mod = await loadExtension();
    const mock = makeMockPi();
    mod.default(mock.api as never);

    const refreshTool = mock.tools.find((tool) => tool.name === 'byomem_file_search_semantic_refresh');
    expect(refreshTool).toBeDefined();
    if (!refreshTool) return;
    expect(refreshTool.parameters).toEqual({
      type: 'object',
      properties: {
        baseDir: { type: 'string' },
        limit: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    });
    await expect(refreshTool.execute('blank-base', { baseDir: '   ' })).rejects.toThrow(/baseDir/i);
    await expect(refreshTool.execute('bad-limit-zero', { limit: 0 })).rejects.toThrow(/limit/i);
    await expect(refreshTool.execute('bad-limit-fraction', { limit: 1.5 })).rejects.toThrow(/limit/i);
    await expect(refreshTool.execute('bad-limit-string', { limit: '2' })).rejects.toThrow(/limit/i);
  });

  it('semantic query ignores incompatible provider/model/configuredDimension/dimension rows and reports incompatible refresh-needed metadata', async () => {
    const runtimeDir = tempDir();
    const projectDir = tempDir('byomem-runtime-sprint-40-incompatible-query-');
    dirs.push(runtimeDir, projectDir);
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', runtimeDir);
    writeFileSync(join(projectDir, 'compatible.txt'), 'compatible semantic body\n', 'utf8');
    writeFileSync(join(projectDir, 'wrong-provider.txt'), 'wrong provider body\n', 'utf8');
    writeFileSync(join(projectDir, 'wrong-model.txt'), 'wrong model body\n', 'utf8');
    writeFileSync(join(projectDir, 'wrong-config.txt'), 'wrong config body\n', 'utf8');
    writeFileSync(join(projectDir, 'wrong-dimension.txt'), 'wrong dimension body\n', 'utf8');
    writeFileSync(join(projectDir, 'legacy-unversioned.txt'), 'legacy unversioned body\n', 'utf8');
    const currentProvider = remoteProviderKey('http://localhost:11434');
    const store = openNativeStore({ fileSearchIncludeTextFiles: true, baseDir: projectDir, fileSearchDbBaseDir: runtimeDir, embeddingBaseUrl: 'http://localhost:11434', embeddingModel: 'current-model', embeddingDimension: 3 });
    stores.push(store);
    const projectKey = resolveFileSearchProjectKey(projectDir);
    const chunks = projectChunks(store.fileSearchDb!.db, projectKey);
    const compatibleChunk = chunks.find((chunk) => chunk.chunk_text.startsWith('compatible semantic'))!;
    const wrongProviderChunk = chunks.find((chunk) => chunk.chunk_text.startsWith('wrong provider'))!;
    const wrongModelChunk = chunks.find((chunk) => chunk.chunk_text.startsWith('wrong model'))!;
    const wrongConfigChunk = chunks.find((chunk) => chunk.chunk_text.startsWith('wrong config'))!;
    const wrongDimensionChunk = chunks.find((chunk) => chunk.chunk_text.startsWith('wrong dimension'))!;
    const legacyUnversionedChunk = chunks.find((chunk) => chunk.chunk_text.startsWith('legacy unversioned'))!;
    seedChunkEmbedding(store.fileSearchDb!.db, compatibleChunk, { model: 'current-model', configuredDimension: 3, dimension: 3, vector: [1, 0, 0], providerKey: currentProvider });
    seedChunkEmbedding(store.fileSearchDb!.db, wrongProviderChunk, { model: 'current-model', configuredDimension: 3, dimension: 3, vector: [1, 0, 0], providerKey: remoteProviderKey('http://other-provider.test') });
    seedChunkEmbedding(store.fileSearchDb!.db, wrongModelChunk, { model: 'old-model', configuredDimension: 3, dimension: 3, vector: [1, 0, 0], providerKey: currentProvider });
    seedChunkEmbedding(store.fileSearchDb!.db, wrongConfigChunk, { model: 'current-model', configuredDimension: 1536, dimension: 3, vector: [1, 0, 0], providerKey: currentProvider });
    seedChunkEmbedding(store.fileSearchDb!.db, wrongDimensionChunk, { model: 'current-model', configuredDimension: 3, dimension: 2, vector: [1, 0], providerKey: currentProvider });
    seedChunkEmbedding(store.fileSearchDb!.db, legacyUnversionedChunk, { model: 'current-model', configuredDimension: 3, dimension: 3, vector: [1, 0, 0], providerKey: currentProvider });
    store.fileSearchDb!.db.prepare('UPDATE indexed_chunk_embeddings SET identity_version = NULL WHERE chunk_id = ?').run(legacyUnversionedChunk.id);

    globalThis.fetch = (async () => new Response(JSON.stringify({ embedding: [1, 0, 0] }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const directHits = await searchIndex(store, { query: 'semantic query', mode: 'semantic', limit: 10 });
    expect(directHits.map((hit) => hit.file?.path)).toEqual([expect.stringContaining('compatible.txt')]);

    closeTrackedStore(stores, store);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main([
      'file-search',
      '--base-dir', projectDir,
      '--mode', 'semantic',
      '--query', 'semantic query',
      '--limit', '10',
      '--embedding-base-url', 'http://localhost:11434',
      '--embedding-model', 'current-model',
      '--embedding-dimension', '3',
      '--json',
    ]);

    const output = parseLastLog(logSpy) as SearchOutput;
    expect(output.results?.map((hit) => hit.file?.path)).toEqual([expect.stringContaining('compatible.txt')]);
    expect(output.semantic).toMatchObject({
      requested: true,
      enabled: true,
      used: true,
      state: 'incompatible',
      refreshNeeded: true,
      incompatible: true,
      projectKey,
      model: 'current-model',
      configuredDimension: 3,
      actualDimensions: [
        { dimension: 2, chunks: 1 },
        { dimension: 3, chunks: 5 },
      ],
      embeddedChunks: 1,
      missingChunks: 0,
      incompatibleChunks: 5,
      refreshNeededChunks: 5,
      failedChunks: 0,
      failures: 0,
      refreshCommand: 'file-search-semantic-refresh',
      refreshTool: 'byomem_file_search_semantic_refresh',
    });
  });

  it('embedding cache identity invalidates across provider/model/dimension boundaries and includes the Sprint 40 identity tuple', async () => {
    const runtimeDir = tempDir();
    const projectDir = tempDir('byomem-runtime-sprint-40-cache-');
    dirs.push(runtimeDir, projectDir);
    writeFileSync(join(projectDir, 'same.txt'), 'same cache-sensitive body\n', 'utf8');
    const fetchProviderA = vi.fn(async () => new Response(JSON.stringify({ embedding: [1, 0, 0] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    globalThis.fetch = fetchProviderA as unknown as typeof fetch;
    const storeA = openNativeStore({ fileSearchIncludeTextFiles: true, baseDir: projectDir, fileSearchDbBaseDir: runtimeDir, embeddingBaseUrl: 'http://provider-a.test/root', embeddingModel: 'cache-model', embeddingDimension: 3 });
    stores.push(storeA);
    await storeA.fileSearchDb!.refreshSemanticIndex();
    expect(fetchProviderA).toHaveBeenCalledTimes(1);
    storeA.fileSearchDb!.db.prepare('DELETE FROM indexed_chunk_embeddings').run();
    closeTrackedStore(stores, storeA);

    const fetchProviderB = vi.fn(async () => new Response(JSON.stringify({ embedding: [0, 1, 0] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    globalThis.fetch = fetchProviderB as unknown as typeof fetch;
    const storeB = openNativeStore({ fileSearchIncludeTextFiles: true, baseDir: projectDir, fileSearchDbBaseDir: runtimeDir, embeddingBaseUrl: 'http://provider-b.test/root', embeddingModel: 'cache-model', embeddingDimension: 3, fileSearchScanOnOpen: false });
    stores.push(storeB);
    await storeB.fileSearchDb!.refreshSemanticIndex();

    expect(fetchProviderB).toHaveBeenCalledTimes(1);
    const cacheRows = storeB.fileSearchDb!.db.prepare('SELECT id, text_hash, model, configured_dimension, dimension FROM file_embedding_cache ORDER BY id').all() as Array<{ id: string; text_hash: string; model: string; configured_dimension: number; dimension: number }>;
    expect(cacheRows).toHaveLength(2);
    expect(cacheRows.map((row) => row.id)).toEqual(expect.arrayContaining([
      expect.stringContaining(`file-search-embedding-v1:${remoteProviderKey('http://provider-a.test/root')}:cache-model:3:3:`),
      expect.stringContaining(`file-search-embedding-v1:${remoteProviderKey('http://provider-b.test/root')}:cache-model:3:3:`),
    ]));
    expect(new Set(cacheRows.map((row) => row.text_hash)).size).toBe(1);
  });
});
