import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNativeStore } from '../src/store.js';
import { searchIndex } from '../src/file-search-query.js';

function tempDir(prefix = 'byomem-runtime-sprint-61-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('Sprint 61 file-search legacy memory artifact exclusion', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('skips native-store.json and native-store.json.migrated while indexing real project files', async () => {
    const projectDir = tempDir('byomem-runtime-sprint-61-project-');
    const runtimeDir = tempDir('byomem-runtime-sprint-61-runtime-');
    dirs.push(projectDir, runtimeDir);
    writeFileSync(join(projectDir, 'native-store.json'), JSON.stringify({ version: 1, records: [{ id: 'legacy-json' }] }, null, 2), 'utf8');
    writeFileSync(join(projectDir, 'native-store.json.migrated'), JSON.stringify({ version: 1, records: [{ id: 'legacy-migrated' }] }, null, 2), 'utf8');
    writeFileSync(join(projectDir, 'notes.txt'), 'legacy artifact exclusion sentinel\n', 'utf8');

    const store = openNativeStore({
      baseDir: runtimeDir,
      fileSearchProjectBaseDir: projectDir,
      fileSearchDbBaseDir: runtimeDir,
      fileSearchScanOnOpen: false,
      fileSearchSchedulerEnabled: false,
      fileSearchSemanticEnabled: false,
      fileSearchIncludeTextFiles: true,
    });

    try {
      const status = store.fileSearchDb!.scanAndIndex({ trigger: 'manual' });
      const indexedPaths = store.fileSearchDb!.db.prepare('SELECT path FROM indexed_files ORDER BY path').all() as Array<{ path: string }>;
      const hits = await searchIndex(store, { query: 'legacy artifact exclusion sentinel', mode: 'bm25' });

      expect(status.progress.ignoredFiles).toBeGreaterThanOrEqual(2);
      expect(indexedPaths.map((row) => row.path)).toEqual([join(projectDir, 'notes.txt')]);
      expect(hits.map((hit) => hit.file?.path ?? hit.chunk.filePath)).toEqual([join(projectDir, 'notes.txt')]);
    } finally {
      store.close();
    }
  });
});
