import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fixtures from './sprint-50-embedding-fixtures.json';
import { buildFileSearchIndex } from '../src/file-search-index.js';
import { openNativeStore } from '../src/store.js';

function tempDir(prefix = 'byomem-sprint-54-benchmark-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function buildFastApiFixture(projectDir: string): void {
  mkdirSync(join(projectDir, 'fastapi', 'dependencies'), { recursive: true });
  mkdirSync(join(projectDir, 'tests'), { recursive: true });
  mkdirSync(join(projectDir, 'docs', 'de', 'docs', 'advanced'), { recursive: true });
  writeFileSync(join(projectDir, 'fastapi', 'param_functions.py'), 'class Depends:\n    pass\n\n\ndef dependency_provider():\n    return Depends()\n', 'utf8');
  writeFileSync(join(projectDir, 'fastapi', 'dependencies', 'utils.py'), 'class Depends:\n    pass\n\n\ndef get_depends():\n    return Depends()\n', 'utf8');
  writeFileSync(join(projectDir, 'tests', 'test_dependency_overrides.py'), 'from fastapi import Depends\n\n\ndef test_dependency_overrides():\n    assert Depends is not None\n', 'utf8');
  writeFileSync(join(projectDir, 'docs', 'de', 'docs', 'advanced', 'wsgi.md'), 'Depends Depends Depends Depends Depends\nThis docs page repeats Depends many times.\n', 'utf8');
}

describe('Sprint 54 file-search benchmark parity', () => {
  const dirs: string[] = [];
  const stores: Array<ReturnType<typeof openNativeStore>> = [];

  afterEach(() => {
    while (stores.length) stores.pop()?.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('produces a repeatable query timing report over the sprint-50 fixture set', async () => {
    const projectDir = tempDir();
    dirs.push(projectDir);
    buildFastApiFixture(projectDir);

    const store = openNativeStore({
      baseDir: projectDir,
      fileSearchIncludeTextFiles: true,
      fileSearchScanOnOpen: true,
      fileSearchSchedulerEnabled: false,
      fileSearchSemanticEnabled: false,
    });
    stores.push(store);

    const index = buildFileSearchIndex(store);
    const report = [];
    for (const query of fixtures.querySet) {
      const startedAt = performance.now();
      const hits = await index.search(query, { mode: 'hybrid', topK: 3 });
      const elapsedMs = performance.now() - startedAt;
      report.push({
        query,
        elapsedMs,
        topPath: hits[0]?.chunk.filePath,
        topPaths: hits.map((hit) => hit.chunk.filePath),
      });
    }

    expect(report).toHaveLength(fixtures.querySet.length);
    expect(report.every((entry) => typeof entry.elapsedMs === 'number' && entry.elapsedMs >= 0)).toBe(true);
    expect(report.every((entry) => typeof entry.query === 'string' && Array.isArray(entry.topPaths))).toBe(true);
    expect(report.some((entry) => entry.topPaths.length > 0)).toBe(true);
    expect(new Set(report.map((entry) => entry.query)).size).toBe(fixtures.querySet.length);
  });
});
