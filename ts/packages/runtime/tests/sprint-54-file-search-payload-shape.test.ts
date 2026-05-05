import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFileSearchIndex } from '../src/file-search-index.js';
import { openNativeStore } from '../src/store.js';

function tempDir(prefix = 'byomem-sprint-54-payload-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('Sprint 54 file-search payload shape', () => {
  const dirs: string[] = [];
  const stores: Array<ReturnType<typeof openNativeStore>> = [];

  afterEach(() => {
    while (stores.length) stores.pop()?.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('returns the Semble-like chunk, identity, metadata, and file payload fields', async () => {
    const projectDir = tempDir();
    dirs.push(projectDir);
    writeFileSync(join(projectDir, 'alpha.txt'), 'alpha payload body\n', 'utf8');

    const store = openNativeStore({
      baseDir: projectDir,
      fileSearchIncludeTextFiles: true,
      fileSearchScanOnOpen: true,
      fileSearchSchedulerEnabled: false,
      fileSearchSemanticEnabled: false,
    });
    stores.push(store);

    const index = buildFileSearchIndex(store);
    const hits = await index.search('alpha payload', { mode: 'bm25', topK: 1 });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      id: expect.any(String),
      scope: 'project',
      source: 'bm25',
      chunk: {
        filePath: join(projectDir, 'alpha.txt'),
        content: expect.any(String),
        startLine: 1,
        endLine: 1,
      },
      identity: {
        namespace: expect.any(String),
        leafName: join(projectDir, 'alpha.txt'),
        parentContext: expect.any(String),
      },
      provenance: {
        source: 'file-search',
      },
      metadata: {
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
      file: {
        projectKey: expect.any(String),
        path: join(projectDir, 'alpha.txt'),
        chunkIndex: expect.any(Number),
        chunkText: expect.any(String),
        chunkHash: expect.any(String),
        startLine: 1,
        endLine: 1,
      },
    });
  });
});
