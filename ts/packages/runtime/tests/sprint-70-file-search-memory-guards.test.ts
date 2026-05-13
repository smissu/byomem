import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFileSearchIndex } from '../src/file-search-index.js';
import { openFileSearchDb, resolveFileSearchProjectKey } from '../src/file-search-db.js';
import { buildSearchSemanticMetadata, searchIndex } from '../src/file-search-query.js';

function trackFullChunkHydration(fileDb: ReturnType<typeof openFileSearchDb>) {
  const handle = fileDb as unknown as { db: Record<string, unknown> };
  const originalDb = handle.db;
  const originalPrepare = (originalDb.prepare as (...args: unknown[]) => unknown).bind(originalDb);
  let fullHydrationCount = 0;
  const proxyDb = new Proxy(originalDb, {
    get(target, prop, receiver) {
      if (prop !== 'prepare') return Reflect.get(target, prop, receiver);
      return ((sql: string, ...args: unknown[]) => {
        const statement = originalPrepare(sql, ...args) as Record<string, unknown>;
        if (
          typeof sql === 'string'
          && sql.includes('SELECT fr.project_key, fr.path, fc.chunk_index')
          && sql.includes('FROM indexed_chunks fc')
          && sql.includes('ORDER BY fc.file_record_id, fc.chunk_index')
        ) {
          return new Proxy(statement, {
            get(statementTarget, statementProp, statementReceiver) {
              if (statementProp !== 'all') return Reflect.get(statementTarget, statementProp, statementReceiver);
              return ((...statementArgs: unknown[]) => {
                fullHydrationCount += 1;
                return Reflect.apply(statementTarget.all as (...allArgs: unknown[]) => unknown, statementTarget, statementArgs);
              }) as never;
            },
          });
        }
        return statement;
      }) as never;
    },
  });
  handle.db = proxyDb;
  return {
    get count(): number {
      return fullHydrationCount;
    },
    restore(): void {
      handle.db = originalDb;
    },
  };
}

describe('Sprint 70 file-search memory guards', () => {
  const dirs: string[] = [];
  const originalBudget = process.env.BYOMEM_FILE_SEARCH_HOT_INDEX_MEMORY_MB;

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    if (originalBudget === undefined) delete process.env.BYOMEM_FILE_SEARCH_HOT_INDEX_MEMORY_MB;
    else process.env.BYOMEM_FILE_SEARCH_HOT_INDEX_MEMORY_MB = originalBudget;
  });

  it('degrades hot-index vector hydration when estimated memory exceeds budget', () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'byomem-s70-memory-runtime-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'byomem-s70-memory-project-'));
    dirs.push(runtimeDir, projectDir);
    writeFileSync(join(projectDir, 'large.txt'), `${'needle '.repeat(200_000)}\n`, 'utf8');
    process.env.BYOMEM_FILE_SEARCH_HOT_INDEX_MEMORY_MB = '1';

    const fileSearchDb = openFileSearchDb({
      baseDir: projectDir,
      projectBaseDir: projectDir,
      dbBaseDir: runtimeDir,
      scanOnOpen: false,
      schedulerEnabled: false,
      semanticSearchEnabled: false,
      scannerIncludeTextFiles: true,
    });
    const store = {
      baseDir: projectDir,
      fileSearchProjectBaseDir: projectDir,
      fileSearchDb,
    };
    try {
      fileSearchDb.scanAndIndex({ trigger: 'manual' });
      const stats = buildFileSearchIndex(store as never).stats();
      expect(stats.hotIndex.memoryGuard).toMatchObject({
        degraded: true,
        reason: 'memory-budget-exceeded',
        budgetMb: 1,
        vectorsSkipped: true,
      });
      expect(stats.hotIndex.vectorCount).toBe(0);
    } finally {
      fileSearchDb.close();
    }
  });

  it('reports DB stats for a cold oversized project without hydrating all chunks', () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'byomem-s70-stats-runtime-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'byomem-s70-stats-project-'));
    dirs.push(runtimeDir, projectDir);
    writeFileSync(join(projectDir, 'large.txt'), `${'needle '.repeat(200_000)}\n`, 'utf8');
    process.env.BYOMEM_FILE_SEARCH_HOT_INDEX_MEMORY_MB = '1';

    const fileSearchDb = openFileSearchDb({
      baseDir: projectDir,
      projectBaseDir: projectDir,
      dbBaseDir: runtimeDir,
      scanOnOpen: false,
      schedulerEnabled: false,
      semanticSearchEnabled: false,
      scannerIncludeTextFiles: true,
    });
    const store = {
      baseDir: projectDir,
      fileSearchProjectBaseDir: projectDir,
      fileSearchDb,
    };
    const tracker = trackFullChunkHydration(fileSearchDb);
    try {
      fileSearchDb.scanAndIndex({ trigger: 'manual' });
      const dbChunkCount = (fileSearchDb.db.prepare('SELECT COUNT(*) AS count FROM indexed_chunks WHERE project_key = ?').get(resolveFileSearchProjectKey(projectDir)) as { count: number }).count;
      const stats = buildFileSearchIndex(store as never).stats();

      expect(stats.index.chunkCount).toBe(dbChunkCount);
      expect(stats.hotIndex).toMatchObject({
        state: 'cold',
        source: 'none',
        chunkCount: 0,
        vectorCount: 0,
        hydrateCount: 0,
      });
      expect(stats.hotIndex.memoryGuard).toMatchObject({
        degraded: true,
        reason: 'memory-budget-exceeded',
        budgetMb: 1,
        vectorsSkipped: true,
      });
      expect(tracker.count).toBe(0);
    } finally {
      tracker.restore();
      fileSearchDb.close();
    }
  });

  it('returns bounded lexical results when semantic hydration is memory-guard degraded', async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'byomem-s70-search-runtime-'));
    const projectDir = mkdtempSync(join(tmpdir(), 'byomem-s70-search-project-'));
    dirs.push(runtimeDir, projectDir);
    writeFileSync(join(projectDir, 'large.txt'), `${'needle '.repeat(200_000)}\n`, 'utf8');
    process.env.BYOMEM_FILE_SEARCH_HOT_INDEX_MEMORY_MB = '1';

    const fileSearchDb = openFileSearchDb({
      baseDir: projectDir,
      projectBaseDir: projectDir,
      dbBaseDir: runtimeDir,
      scanOnOpen: false,
      schedulerEnabled: false,
      semanticSearchEnabled: true,
      scannerIncludeTextFiles: true,
    });
    const store = {
      baseDir: projectDir,
      fileSearchProjectBaseDir: projectDir,
      fileSearchDb,
    };
    try {
      fileSearchDb.scanAndIndex({ trigger: 'manual' });
      const hits = await searchIndex(store as never, {
        query: 'needle',
        limit: 3,
        includeGraph: true,
        mode: 'hybrid',
      } as never);
      const semantic = await buildSearchSemanticMetadata(store as never, { query: 'needle', limit: 3, mode: 'hybrid' }, hits);

      expect(hits.length).toBeGreaterThan(0);
      expect(hits).toHaveLength(Math.min(3, hits.length));
      expect(hits[0]?.chunk.content).toContain('needle');
      expect(hits[0]?.file?.semanticScore).toBeUndefined();
      expect(semantic).toMatchObject({
        requested: true,
        used: false,
        degraded: true,
        degradeReason: 'memory-budget-exceeded',
      });
    } finally {
      fileSearchDb.close();
    }
  });
});
