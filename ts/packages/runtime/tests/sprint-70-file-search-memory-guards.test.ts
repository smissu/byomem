import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFileSearchIndex } from '../src/file-search-index.js';
import { openFileSearchDb } from '../src/file-search-db.js';

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
});
