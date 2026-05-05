import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSearchIndex, FileSearchIndexBuilder, buildFileSearchIndex } from '../src/index.js';
import { resolveFileSearchProjectKey } from '../src/file-search-db.js';
import { openNativeStore } from '../src/store.js';

function tempDir(prefix = 'byomem-sprint-54-index-contract-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('Sprint 54 file-search index contract', () => {
  const dirs: string[] = [];
  const stores: Array<ReturnType<typeof openNativeStore>> = [];

  afterEach(() => {
    while (stores.length) stores.pop()?.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('builds a Semble-shaped index from a project path and returns stable search/stats output', async () => {
    const projectDir = tempDir();
    dirs.push(projectDir);
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'alpha.ts'), 'export function alphaRoute() {\n  return 1;\n}\n', 'utf8');
    writeFileSync(join(projectDir, 'src', 'beta.ts'), 'export function betaRoute() {\n  return 2;\n}\n', 'utf8');
    writeFileSync(join(projectDir, 'notes.md'), 'alpha project notes\n', 'utf8');

    const store = openNativeStore({
      baseDir: projectDir,
      fileSearchIncludeTextFiles: true,
      fileSearchScanOnOpen: false,
      fileSearchSchedulerEnabled: false,
      fileSearchSemanticEnabled: false,
    });
    stores.push(store);
    store.fileSearchDb?.scanAndIndex();

    const builder = FileSearchIndexBuilder.fromPath(projectDir);
    const index = builder.build(store);
    const directIndex = FileSearchIndex.fromPath(store, projectDir);
    const helperIndex = buildFileSearchIndex(store);

    expect(index.identityInfo).toMatchObject({
      sourceType: 'path',
      baseDir: projectDir,
      projectKey: resolveFileSearchProjectKey(projectDir),
      sourceFingerprint: expect.any(String),
    });
    expect(directIndex.identityInfo).toMatchObject(index.identityInfo);
    expect(helperIndex.identityInfo).toMatchObject(index.identityInfo);
    expect(index.buildInfo.projectFingerprint).toBe(index.identityInfo.sourceFingerprint);

    const stats = index.stats();
    expect(stats).toMatchObject({
      index: {
        projectKey: resolveFileSearchProjectKey(projectDir),
        baseDir: projectDir,
        sourceType: 'path',
        indexedFiles: 3,
        chunkCount: expect.any(Number),
        perLanguageCounts: expect.objectContaining({
          typescript: expect.any(Number),
          text: expect.any(Number),
        }),
      },
      build: {
        backendVersion: expect.any(String),
        projectFingerprint: expect.any(String),
        elapsedMs: expect.any(Number),
      },
      embedding: {
        enabled: false,
        model: expect.any(String),
        providerKey: expect.any(String),
        dimension: expect.any(Number),
        vectorByteSize: expect.any(Number),
        configuredDimension: expect.any(Number),
      },
    });

    const bm25Hits = await index.search('alpha route', { mode: 'bm25', topK: 5, filterLanguages: ['typescript'] });
    expect(bm25Hits).not.toHaveLength(0);
    expect(bm25Hits[0]).toMatchObject({
      source: 'bm25',
      chunk: {
        filePath: join(projectDir, 'src', 'alpha.ts'),
        startLine: 1,
        endLine: expect.any(Number),
      },
      identity: {
        namespace: expect.any(String),
        leafName: expect.any(String),
        parentContext: expect.any(String),
      },
    });

    const wrapperHits = await helperIndex.search('alpha route', { mode: 'bm25', topK: 5, filterLanguages: ['typescript'] });
    expect(wrapperHits).toEqual(bm25Hits);

    const related = await index.findRelated({ filePath: join(projectDir, 'src', 'alpha.ts'), line: 1 }, { topK: 3 });
    expect(related).not.toHaveLength(0);
    expect(related[0]).toMatchObject({
      source: expect.any(String),
      chunk: {
        filePath: expect.any(String),
        startLine: expect.any(Number),
        endLine: expect.any(Number),
      },
    });

    const gitIndex = FileSearchIndexBuilder.fromGit('https://example.com/semble-contract.git', { baseDir: projectDir }).build(store);
    expect(gitIndex.identityInfo).toMatchObject({
      sourceType: 'git',
      baseDir: projectDir,
      projectKey: resolveFileSearchProjectKey(projectDir),
      sourceFingerprint: expect.any(String),
    });
    expect(gitIndex.identityInfo.sourceFingerprint).not.toBe(index.identityInfo.sourceFingerprint);
  });
});
