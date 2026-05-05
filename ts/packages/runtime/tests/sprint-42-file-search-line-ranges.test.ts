import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { FILE_SEARCH_EMBEDDING_IDENTITY_VERSION, FALLBACK_EMBEDDING_PROVIDER_KEY } from '../src/embedding-client.js';
import { encodeEmbedding } from '../src/embedding-vector.js';
import { openFileSearchDb, resolveFileSearchProjectKey } from '../src/file-search-db.js';
import { searchIndex } from '../src/file-search-query.js';
import { openNativeStore } from '../src/store.js';

type Store = ReturnType<typeof openNativeStore>;
type ChunkRow = {
  id: string;
  project_key: string;
  file_record_id: string;
  chunk_index: number;
  chunk_text: string;
  chunk_hash: string;
  start_line?: number | null;
  end_line?: number | null;
};

type RegisteredTool = {
  name: string;
  execute: (...args: any[]) => Promise<unknown>;
};

function tempDir(prefix = 'byomem-s42-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function chunks(db: BetterSqliteDatabase, projectKey: string): ChunkRow[] {
  return db.prepare(`
    SELECT id, project_key, file_record_id, chunk_index, chunk_text, chunk_hash, start_line, end_line
    FROM indexed_chunks
    WHERE project_key = ?
    ORDER BY chunk_index
  `).all(projectKey) as ChunkRow[];
}

function seedEmbedding(db: BetterSqliteDatabase, chunk: ChunkRow, vector: number[], options: { model?: string; dimension?: number } = {}): void {
  const now = new Date().toISOString();
  const dimension = options.dimension ?? vector.length;
  db.prepare(`INSERT OR REPLACE INTO indexed_chunk_embeddings
    (chunk_id, project_key, file_record_id, chunk_index, chunk_hash, text_hash, model, configured_dimension, embedding, dimension, provider_key, effective_dimension, identity_version, status, error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', NULL, ?, ?)`)
    .run(
      chunk.id,
      chunk.project_key,
      chunk.file_record_id,
      chunk.chunk_index,
      chunk.chunk_hash,
      sha256(chunk.chunk_text),
      options.model ?? 'line-model',
      dimension,
      encodeEmbedding(vector),
      dimension,
      FALLBACK_EMBEDDING_PROVIDER_KEY,
      dimension,
      FILE_SEARCH_EMBEDDING_IDENTITY_VERSION,
      now,
      now,
    );
}

function makeMockPi() {
  const tools: RegisteredTool[] = [];
  return {
    tools,
    api: {
      on() {},
      registerCommand() {},
      registerTool(tool: RegisteredTool) { tools.push(tool); },
    },
  };
}

async function loadExtension() {
  vi.resetModules();
  return import('../src/pi-extension.ts');
}

describe('Sprint 42 file-search source line ranges', () => {
  const dirs: string[] = [];
  const stores: Store[] = [];
  const originalRuntimeBase = process.env.BYOMEM_RUNTIME_BASE_DIR;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    while (stores.length) stores.pop()?.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    if (originalRuntimeBase === undefined) delete process.env.BYOMEM_RUNTIME_BASE_DIR;
    else process.env.BYOMEM_RUNTIME_BASE_DIR = originalRuntimeBase;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.resetModules();
    process.exitCode = undefined;
  });

  it('migrates indexed_chunks with nullable line columns and indexes physical line ranges', () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'lines.txt'), 'alpha one\n\nrepeat line\nrepeat line\n  \nomega last\n', 'utf8');

    const fileDb = openFileSearchDb({ baseDir: dir, scanOnOpen: true, schedulerEnabled: false, semanticSearchEnabled: false });
    try {
      const columns = fileDb.db.prepare('PRAGMA table_info(indexed_chunks)').all() as Array<{ name: string; notnull: number }>;
      expect(columns).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'start_line', notnull: 0 }),
        expect.objectContaining({ name: 'end_line', notnull: 0 }),
      ]));
      const rows = chunks(fileDb.db, resolveFileSearchProjectKey(dir));
      expect(rows.map((row) => ({ text: row.chunk_text, index: row.chunk_index, start: row.start_line, end: row.end_line }))).toEqual([
        { text: 'alpha one\n\nrepeat line\nrepeat line\n  \nomega last', index: 0, start: 1, end: 6 },
      ]);
    } finally {
      fileDb.close();
    }
  });

  it('backfills NULL line metadata when rescanning an otherwise unchanged indexed file', () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'legacy-lines.txt'), 'first legacy line\n\nsecond legacy line\n', 'utf8');

    const fileDb = openFileSearchDb({ baseDir: dir, scanOnOpen: false, schedulerEnabled: false, embeddingModel: 'line-model', embeddingDimension: 3 });
    try {
      const projectKey = resolveFileSearchProjectKey(dir);
      const seeded = fileDb.scanAndIndex({ trigger: 'manual' });
      expect(seeded.progress).toMatchObject({ indexedFiles: 1, changedFiles: 1, chunksWritten: 1 });

      const firstRows = chunks(fileDb.db, projectKey);
      expect(firstRows.map((row) => ({ text: row.chunk_text, start: row.start_line, end: row.end_line }))).toEqual([
        { text: 'first legacy line\n\nsecond legacy line', start: 1, end: 3 },
      ]);
      firstRows.forEach((row, index) => seedEmbedding(fileDb.db, row, [index + 1, 0, 0]));
      expect(fileDb.getEmbeddingDiagnostics()).toMatchObject({
        state: 'ready',
        missingChunks: 0,
        embeddedChunks: firstRows.length,
        refreshNeededChunks: 0,
      });

      const unchanged = fileDb.scanAndIndex({ trigger: 'manual' });
      expect(unchanged.progress).toMatchObject({ unchangedFiles: 1, indexedFiles: 0, changedFiles: 0, chunksWritten: 0 });

      fileDb.db.prepare('UPDATE indexed_chunks SET start_line = NULL, end_line = NULL WHERE project_key = ?').run(projectKey);
      expect(chunks(fileDb.db, projectKey).every((row) => row.start_line == null && row.end_line == null)).toBe(true);

      const backfilled = fileDb.scanAndIndex({ trigger: 'manual' });
      expect(backfilled.progress).toMatchObject({ unchangedFiles: 0, indexedFiles: 1, changedFiles: 1, chunksWritten: 1 });
      expect(chunks(fileDb.db, projectKey).map((row) => ({ text: row.chunk_text, start: row.start_line, end: row.end_line }))).toEqual([
        { text: 'first legacy line\n\nsecond legacy line', start: 1, end: 3 },
      ]);
      expect(fileDb.db.prepare('SELECT chunk_id, status FROM indexed_chunk_embeddings WHERE project_key = ? ORDER BY chunk_index').all(projectKey) as Array<{ chunk_id: string; status: string }>).toEqual(
        firstRows.map((row) => ({ chunk_id: row.id, status: 'ready' })),
      );
      expect(fileDb.getEmbeddingDiagnostics()).toMatchObject({
        state: 'ready',
        missingChunks: 0,
        embeddedChunks: firstRows.length,
        refreshNeededChunks: 0,
        failedChunks: 0,
      });
    } finally {
      fileDb.close();
    }
  });

  it('returns line ranges from FTS, semantic, and hybrid results while old rows without metadata remain searchable', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'search.txt'), 'needle lexical\n\nsemantic needle target\n', 'utf8');
    const store = openNativeStore({ baseDir: dir, embeddingModel: 'line-model', embeddingDimension: 3, fileSearchSchedulerEnabled: false });
    stores.push(store);
    const projectKey = resolveFileSearchProjectKey(dir);
    const rows = chunks(store.fileSearchDb!.db, projectKey);
    seedEmbedding(store.fileSearchDb!.db, rows[0]!, [1, 0, 0]);
    globalThis.fetch = (async () => new Response(JSON.stringify({ embedding: [1, 0, 0] }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    const fts = await searchIndex(store, { query: 'semantic needle', mode: 'fts', limit: 5 });
    expect(fts[0]?.file).toMatchObject({ chunkIndex: 0, startLine: 1, endLine: 3 });

    const semantic = await searchIndex(store, { query: 'semantic needle', mode: 'semantic', limit: 5 });
    expect(semantic[0]?.file).toMatchObject({ chunkIndex: 0, startLine: 1, endLine: 3 });

    const hybrid = await searchIndex(store, { query: 'semantic needle', mode: 'hybrid', limit: 5 });
    expect(hybrid[0]?.file).toMatchObject({ chunkIndex: 0, startLine: 1, endLine: 3 });

    const now = new Date().toISOString();
    const fileRecordId = `file-record:${projectKey}:legacy.txt`;
    const legacyPath = join(dir, 'legacy.txt');
    store.fileSearchDb!.db.prepare('INSERT OR REPLACE INTO file_records (id, project_key, path, content_hash, mtime_ms, size_bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(fileRecordId, projectKey, legacyPath, 'legacy-hash', 1, 1, now, now);
    store.fileSearchDb!.db.prepare('INSERT OR REPLACE INTO indexed_files (id, project_key, path, file_record_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`indexed-file:${projectKey}:legacy.txt`, projectKey, legacyPath, fileRecordId, now, now);
    store.fileSearchDb!.db.prepare('INSERT OR REPLACE INTO indexed_chunks (id, project_key, file_record_id, chunk_index, chunk_text, chunk_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(`indexed-chunk:${projectKey}:legacy.txt:0`, projectKey, fileRecordId, 0, 'legacy searchable line', 'legacy-chunk-hash', now, now);

    const legacy = await searchIndex(store, { query: 'legacy searchable', mode: 'fts', limit: 1 });
    expect(legacy[0]?.file).toMatchObject({ path: legacyPath, chunkIndex: 0 });
    expect(legacy[0]?.file).not.toHaveProperty('startLine');
    expect(legacy[0]?.file).not.toHaveProperty('endLine');
  });

  it('exposes line ranges through CLI JSON and Pi direct tool output with public naming contracts', async () => {
    const runtimeDir = tempDir('byomem-s42-runtime-');
    const projectDir = tempDir('byomem-s42-project-');
    dirs.push(runtimeDir, projectDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    writeFileSync(join(projectDir, 'tool.txt'), 'first line\n\ntool needle line\n', 'utf8');

    const scanDb = openFileSearchDb({ baseDir: projectDir, dbBaseDir: runtimeDir, scanOnOpen: true, schedulerEnabled: false, semanticSearchEnabled: false });
    scanDb.close();

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['file-search', '--base-dir', projectDir, '--query', 'tool needle', '--mode', 'fts', '--limit', '1', '--json']);
    const cliPayload = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}')) as { results?: Array<{ chunk?: Record<string, unknown> }> };
    expect(cliPayload.results?.[0]?.chunk).toMatchObject({ filePath: join(projectDir, 'tool.txt'), startLine: 1, endLine: 3 });

    const mod = await loadExtension();
    const mock = makeMockPi();
    mod.default(mock.api as never);
    const tool = mock.tools.find((entry) => entry.name === 'byomem_file_search')!;
    const directPayload = await tool.execute('1', { baseDir: projectDir, query: 'tool needle', mode: 'fts', limit: 1 }) as { results?: Array<{ chunk?: Record<string, unknown> }> };
    expect(directPayload.results?.[0]?.chunk).toMatchObject({ filePath: join(projectDir, 'tool.txt'), startLine: 1, endLine: 3 });
  });
});
