import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNativeStore } from '../src/store.js';
import { resolveFileSearchProjectKey } from '../src/file-search-db.js';
import { searchIndex } from '../src/file-search-query.js';

type FileSearchDbHandle = {
  path: string;
  close: () => void;
  scanAndIndex?: () => void;
  db?: {
    prepare: (sql: string) => {
      all: (...args: unknown[]) => unknown[];
      get: (...args: unknown[]) => unknown;
      run: (...args: unknown[]) => unknown;
    };
  };
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-runtime-sprint-29-'));
}

describe('Sprint 29 file search MVP', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it('uses the file-search DB as the search source and returns project-scoped BM25-first results', async () => {
    const dir = tempDir();
    dirs.push(dir);
    mkdirSync(join(dir, 'project-a'), { recursive: true });
    mkdirSync(join(dir, 'project-b'), { recursive: true });
    writeFileSync(join(dir, 'project-a', 'alpha.md'), 'alpha lexical match\n', 'utf8');
    writeFileSync(join(dir, 'project-b', 'alpha.md'), 'alpha lexical match other project\n', 'utf8');

    const store = openNativeStore({ fileSearchIncludeTextFiles: true, baseDir: dir });
    const fileDb = (store as unknown as { fileSearchDb?: FileSearchDbHandle }).fileSearchDb;

    expect(fileDb).toBeDefined();
    const results = await searchIndex(store, { query: 'alpha lexical', scope: 'project' });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((record) => record.scope === 'project')).toBe(true);
    expect(results.map((record) => record.id)).toContainEqual(expect.stringContaining('alpha'));
    expect(fileDb?.db?.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', 'indexed_chunks')).toMatchObject({ name: 'indexed_chunks' });
    expect(fileDb?.db?.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', 'indexed_chunks_fts')).toMatchObject({ name: 'indexed_chunks_fts' });
  });

  it('keeps search results project-scoped by default', async () => {
    const dir = tempDir();
    dirs.push(dir);
    mkdirSync(join(dir, 'project-a'), { recursive: true });
    writeFileSync(join(dir, 'project-a', 'scoped.txt'), 'scoped result content\n', 'utf8');

    const store = openNativeStore({ fileSearchIncludeTextFiles: true, baseDir: dir });
    const results = await searchIndex(store, { query: 'scoped result' });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((record) => record.scope === 'project')).toBe(true);
  });

  it('returns grounded file and chunk metadata for search hits', async () => {
    const dir = tempDir();
    dirs.push(dir);
    mkdirSync(join(dir, 'project-a'), { recursive: true });
    writeFileSync(join(dir, 'project-a', 'grounded.txt'), 'grounded metadata content\n', 'utf8');

    const store = openNativeStore({ fileSearchIncludeTextFiles: true, baseDir: dir });
    const results = await searchIndex(store, { query: 'grounded metadata' });

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.any(String),
          scope: 'project',
          identity: expect.objectContaining({}),
        }),
      ]),
    );
  });

  it('filters stale indexed chunks that contain raw session support fields', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const store = openNativeStore({ fileSearchIncludeTextFiles: true, baseDir: dir, fileSearchScanOnOpen: false });
    const fileDb = (store as unknown as { fileSearchDb?: FileSearchDbHandle }).fileSearchDb;
    const projectKey = resolveFileSearchProjectKey(dir);
    const now = new Date().toISOString();
    const filePath = join(dir, 'queue.json');
    const fileRecordId = `file-record:${projectKey}:queue.json`;

    fileDb?.db?.prepare('INSERT OR REPLACE INTO file_records (id, project_key, path, content_hash, mtime_ms, size_bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(fileRecordId, projectKey, filePath, 'stale-hash', 1, 1, now, now);
    fileDb?.db?.prepare('INSERT OR REPLACE INTO indexed_files (id, project_key, path, file_record_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`indexed-file:${projectKey}:queue.json`, projectKey, filePath, fileRecordId, now, now);
    fileDb?.db?.prepare('INSERT OR REPLACE INTO indexed_chunks (id, project_key, file_record_id, chunk_index, chunk_text, chunk_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(`indexed-chunk:${projectKey}:queue.json:0`, projectKey, fileRecordId, 0, '{"thinkingSignature":"hidden-signature","encrypted_content":"opaque","body":"stale searchable"}', 'stale-chunk-hash', now, now);

    await expect(searchIndex(store, { query: 'stale searchable hidden', mode: 'bm25' })).resolves.toEqual([]);
  });

  it('keeps file-search search isolated from the memories DB sidecar', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'isolation.txt'), 'isolation search content\n', 'utf8');

    const store = openNativeStore({ fileSearchIncludeTextFiles: true, baseDir: dir });
    const fileDb = (store as unknown as { fileSearchDb?: FileSearchDbHandle }).fileSearchDb;

    expect(fileDb).toBeDefined();
    expect(fileDb?.path).toMatch(/byomem-file-search\.sqlite$/);
    expect(store.sidecar?.path).toMatch(/byomem-index\.sqlite$/);
    expect(fileDb?.path).not.toBe(store.sidecar?.path);
    expect(() => fileDb?.db?.prepare('SELECT * FROM records').all()).toThrow();
    expect(() => fileDb?.db?.prepare('SELECT * FROM record_embeddings').all()).toThrow();
  });

  it('defers semantic retrieval and keeps the MVP grounded on BM25 output only', async () => {
    const dir = tempDir();
    dirs.push(dir);
    mkdirSync(join(dir, 'project-a'), { recursive: true });
    writeFileSync(join(dir, 'project-a', 'semantic.txt'), 'semantic grounding content\n', 'utf8');

    const store = openNativeStore({ fileSearchIncludeTextFiles: true, baseDir: dir });
    const fileDb = (store as unknown as { fileSearchDb?: FileSearchDbHandle }).fileSearchDb;

    expect(fileDb).toBeDefined();
    const chunkRows = fileDb?.db?.prepare('SELECT * FROM indexed_chunks').all();
    expect(chunkRows?.length).toBeGreaterThan(0);

    const semanticResult = await searchIndex(store, { query: 'semantic grounding', mode: 'hybrid' });
    expect(semanticResult.length).toBeGreaterThan(0);
    expect(semanticResult.every((record) => record.scope === 'project')).toBe(true);
    expect(semanticResult).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provenance: expect.objectContaining({ adapter: 'semantic' }),
        }),
      ]),
    );
  });
});
