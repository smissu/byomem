import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFileSearchIndex } from '../src/file-search-index.js';
import { searchIndex as searchFileIndex } from '../src/file-search-query.js';
import { openNativeStore } from '../src/store.js';

function tempDir(prefix = 'byomem-sprint-54-chunking-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('Sprint 54 file-search chunking parity', () => {
  const dirs: string[] = [];
  const stores: Array<ReturnType<typeof openNativeStore>> = [];

  afterEach(() => {
    while (stores.length) stores.pop()?.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('preserves stable line-aware chunk metadata through index search and related lookups', async () => {
    const projectDir = tempDir();
    dirs.push(projectDir);
    writeFileSync(join(projectDir, 'search.txt'), 'needle lexical\n\nsemantic needle target\n', 'utf8');
    writeFileSync(join(projectDir, 'companion.txt'), 'needle lexical companion\n\nsemantic needle target companion\n', 'utf8');

    const store = openNativeStore({
      baseDir: projectDir,
      fileSearchIncludeTextFiles: true,
      fileSearchScanOnOpen: true,
      fileSearchSchedulerEnabled: false,
      fileSearchSemanticEnabled: false,
    });
    stores.push(store);

    const index = buildFileSearchIndex(store);
    const hits = await index.search('semantic needle', { mode: 'bm25', topK: 5 });
    expect(hits[0]).toMatchObject({
      chunk: {
        filePath: join(projectDir, 'search.txt'),
        startLine: 1,
        endLine: 3,
      },
      file: {
        path: join(projectDir, 'search.txt'),
        chunkIndex: expect.any(Number),
        startLine: 1,
        endLine: 3,
      },
      identity: {
        namespace: expect.any(String),
        leafName: join(projectDir, 'search.txt'),
        parentContext: expect.any(String),
      },
    });

    const wrapperHits = await searchFileIndex(store, { query: 'semantic needle', mode: 'bm25', limit: 5 });
    expect(wrapperHits[0]?.chunk).toMatchObject({
      filePath: join(projectDir, 'search.txt'),
      startLine: 1,
      endLine: 3,
    });

    const related = await index.findRelated({ filePath: join(projectDir, 'search.txt'), line: 2 }, { topK: 3 });
    expect(related).not.toHaveLength(0);
    expect(related[0]?.chunk).toMatchObject({
      filePath: join(projectDir, 'companion.txt'),
      startLine: 1,
      endLine: 3,
    });
  });
});
