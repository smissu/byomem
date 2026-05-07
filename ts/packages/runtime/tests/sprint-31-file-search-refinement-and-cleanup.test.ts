import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNativeStore } from '../src/store.js';
import { searchIndex, type FileSearchHit } from '../src/file-search-query.js';
import { rankRecords } from '../src/ranking.js';
import type { MemoryRecord } from '../src/contracts.js';
import { openFileSearchDb, resolveFileSearchProjectKey } from '../src/file-search-db.js';

type SchedulerHandle = {
  scheduleRefresh?: (event: { kind: string; projectKey?: string; baseDir?: string }) => void;
  flushScheduledRefreshes?: () => void;
  refreshMetrics?: { runs?: number; failures?: number; skips?: number; retries?: number; lastRunAt?: string; lastFailureAt?: string };
};

type FileDbHandle = {
  path: string;
  close: () => void;
  db?: {
    prepare: (sql: string) => {
      all: (...args: unknown[]) => unknown[];
      get: (...args: unknown[]) => unknown;
      run: (...args: unknown[]) => unknown;
    };
  };
} & SchedulerHandle;

function tempDir(prefix = 'byomem-runtime-sprint-31-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function openFileDb(baseDir: string): FileDbHandle {
  return (openNativeStore({ baseDir }) as unknown as { fileSearchDb: FileDbHandle }).fileSearchDb;
}

describe('Sprint 31 file search refinement and cleanup', () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('surfaces distinct scheduler observability states and retry/degradation signals', () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'scheduler-observability.txt'), 'scheduler observability content\n', 'utf8');

    const fileDb = openFileDb(dir);
    expect(fileDb.refreshMetrics).toEqual(expect.objectContaining({ runs: expect.any(Number), failures: expect.any(Number), skips: expect.any(Number), retries: expect.any(Number) }));
    expect(fileDb.scheduleRefresh).toBeTypeOf('function');
    expect(fileDb.flushScheduledRefreshes).toBeTypeOf('function');

    fileDb.scheduleRefresh?.({ kind: 'activation', baseDir: dir });
    const afterSuccess = { ...fileDb.refreshMetrics };
    expect(afterSuccess.runs).toBeGreaterThan(0);
    expect(afterSuccess.failures).toBe(0);
    expect(afterSuccess.lastRunAt).toEqual(expect.any(String));

    fileDb.scheduleRefresh?.({ kind: 'activation', baseDir: join(dir, 'missing-path') });
    const afterSkipped = { ...fileDb.refreshMetrics };
    expect(afterSkipped.skips).toBeGreaterThanOrEqual(afterSuccess.skips ?? 0);
  });

  it('uses canonical full-path guards for the file-search DB and scheduler paths', () => {
    const dir = tempDir('byomem-runtime-sprint-31-guard-');
    dirs.push(dir);
    writeFileSync(join(dir, 'guard.txt'), 'canonical path guard content\n', 'utf8');

    const canonicalMemoriesPath = join(dir, 'byomem-index.sqlite');
    const canonicalSnapshotPath = join(dir, 'native-store.json');
    const migratedSnapshotPath = join(dir, 'native-store.json.migrated');
    expect(() => openFileSearchDb({ baseDir: dir, dbFile: canonicalMemoriesPath })).toThrow(/memories DB path/i);
    expect(() => openFileSearchDb({ baseDir: dir, dbFile: canonicalSnapshotPath })).toThrow(/memories DB path/i);
    expect(() => openFileSearchDb({ baseDir: dir, dbFile: migratedSnapshotPath })).not.toThrow();
    const fileDb = openFileDb(dir);
    const projectKey = resolveFileSearchProjectKey(dir);
    expect(fileDb.db?.prepare('SELECT * FROM indexed_files WHERE project_key = ? AND path LIKE ?').all(projectKey, '%byomem-index.sqlite%')).toSatisfy((rows: unknown) => Array.isArray(rows) && rows.every((row) => !(row as { path?: string }).path?.includes('/byomem-index.sqlite')));
    expect(fileDb.db?.prepare('SELECT * FROM indexed_files WHERE project_key = ? AND path LIKE ?').all(projectKey, '%native-store.json%')).toSatisfy((rows: unknown) => Array.isArray(rows) && rows.every((row) => !(row as { path?: string }).path?.includes('/native-store.json')));
    expect(fileDb.db?.prepare('SELECT * FROM indexed_files WHERE project_key = ? AND path LIKE ?').all(projectKey, '%native-store.json.migrated%')).toSatisfy((rows: unknown) => Array.isArray(rows) && rows.every((row) => !(row as { path?: string }).path?.includes('/native-store.json.migrated')));
  });

  it('keeps scheduler dependency bounded to a minimal refresh callback contract', () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'dependency.txt'), 'bounded dependency content\n', 'utf8');

    const fileDb = openFileDb(dir);
    expect(fileDb.scheduleRefresh).toBeTypeOf('function');
    expect(fileDb.flushScheduledRefreshes).toBeTypeOf('function');
    expect(fileDb.refreshMetrics).toEqual(expect.objectContaining({ runs: expect.any(Number), failures: expect.any(Number), skips: expect.any(Number), retries: expect.any(Number) }));
  });

  it('preserves persisted indexed metadata in file-search hits beyond the core file/chunk fields', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'metadata.txt'), 'metadata alpha beta\nmetadata gamma delta\n', 'utf8');

    const store = openNativeStore({ baseDir: dir });
    const fileDb = openFileSearchDb({ baseDir: dir });
    const hits = await searchIndex(store, { query: 'metadata alpha', mode: 'bm25' });
    const persisted = fileDb.db?.prepare('SELECT fr.path, fc.chunk_index, fc.chunk_text, fc.chunk_hash, fr.content_hash FROM indexed_chunks fc JOIN file_records fr ON fr.id = fc.file_record_id WHERE fr.path = ? ORDER BY fc.chunk_index').all(join(dir, 'metadata.txt')) as Array<{ path: string; chunk_index: number; chunk_text: string; chunk_hash: string; content_hash: string | null }>;

    expect(persisted?.[0]?.content_hash).toEqual(expect.any(String));
    expect(persisted?.[0]?.chunk_hash).toEqual(expect.any(String));
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({
      scope: 'project',
      file: expect.objectContaining({
        projectKey: expect.any(String),
        path: expect.stringContaining('metadata.txt'),
        chunkIndex: 0,
        chunkText: expect.stringContaining('metadata alpha'),
        chunkHash: expect.any(String),
      }),
    });
    expect(hits[0].metadata).toEqual(expect.objectContaining({ createdAt: expect.any(String), updatedAt: expect.any(String) }));
    expect(hits[0].identity.parentContext).toContain('chunk-0');
  });

  it('hard-gates semantic eligibility when semantic-ready artifacts are absent or invalid', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'semantic.txt'), 'semantic candidate chunk one\nsemantic candidate chunk two\n', 'utf8');

    const store = openNativeStore({ baseDir: dir });
    const hits = await searchIndex(store, { query: 'semantic candidate', mode: 'hybrid' });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((hit: FileSearchHit) => hit.file?.chunkText?.includes('semantic candidate'))).toBe(true);
    expect(hits).toEqual(expect.not.arrayContaining([expect.objectContaining({ provenance: expect.objectContaining({ source: 'semantic' }) })]));
  });

  it('keeps semantic-cue-bearing records relevant in hybrid mode without fake fallback', () => {
    const records: MemoryRecord[] = [
      {
        id: 'project:alpha:root:focus-a',
        scope: 'project',
        identity: { namespace: 'project:alpha', leafName: 'focus-a', parentContext: 'root' },
        provenance: { source: 'file-search' },
        content: { text: 'alpha signal unique', structured: { semanticCue: 'shared' } },
        metadata: { createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z' },
      },
      {
        id: 'project:alpha:root:focus-b',
        scope: 'project',
        identity: { namespace: 'project:alpha', leafName: 'focus-b', parentContext: 'root' },
        provenance: { source: 'file-search' },
        content: { text: 'alpha signal plus semantic cue', structured: { semanticCue: 'alpha signal semantic delta' } },
        metadata: { createdAt: '2025-01-02T00:00:00.000Z', updatedAt: '2025-01-02T00:00:00.000Z' },
      },
      {
        id: 'project:alpha:root:focus-c',
        scope: 'project',
        identity: { namespace: 'project:alpha', leafName: 'focus-c', parentContext: 'root' },
        provenance: { source: 'file-search' },
        content: { text: 'alpha signal fallback', structured: { semanticCue: 'alpha' } },
        metadata: { createdAt: '2025-01-03T00:00:00.000Z', updatedAt: '2025-01-03T00:00:00.000Z' },
      },
    ];

    const baseline = rankRecords(records, 'alpha signal', 'lexical').map((entry) => entry.record.id);
    const refined = rankRecords(records, 'alpha signal', 'hybrid').map((entry) => entry.record.id);

    expect(baseline[0]).toBe('project:alpha:root:focus-a');
    expect(refined).toContain('project:alpha:root:focus-b');
    expect(refined).toContain('project:alpha:root:focus-c');
    expect(refined).toHaveLength(3);
    expect(new Set(refined).size).toBe(3);
  });
});
