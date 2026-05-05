import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFileSearchIndex } from '../src/file-search-index.js';
import { chunkFileContentReady } from '../src/file-search-semble.js';
import { openNativeStore } from '../src/store.js';

type Store = ReturnType<typeof openNativeStore>;
type ChunkReport = {
  filePath: string;
  startLine: number;
  endLine: number;
  source?: string;
  fallbackReason?: string | null;
};

function tempDir(prefix = 'byomem-s57-benchmark-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function seedProject(projectDir: string, sourceContent: string, targetPath: string, query: string): void {
  mkdirSync(join(projectDir, 'ts', 'packages', 'runtime', 'src'), { recursive: true });
  mkdirSync(join(projectDir, 'docs'), { recursive: true });
  writeFileSync(join(projectDir, 'docs', 'query.md'), `${query}\n${query}\n`, 'utf8');
  writeFileSync(targetPath, sourceContent, 'utf8');
}

describe('Sprint 57 file-search chonkie parity benchmark', () => {
  const dirs: string[] = [];
  const stores: Store[] = [];

  afterEach(() => {
    while (stores.length) stores.pop()?.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('records chunk source and fallback reason in the parity report alongside the implementation query', async () => {
    const query = 'configured concurrency caps embedMany batch size refreshSemanticIndex';
    const projectDir = tempDir();
    dirs.push(projectDir);
    const targetPath = join(projectDir, 'ts', 'packages', 'runtime', 'src', 'file-search-db.ts');
    const sourcePath = fileURLToPath(new URL('../src/file-search-db.ts', import.meta.url));
    const sourceContent = readFileSync(sourcePath, 'utf8');
    seedProject(projectDir, sourceContent, targetPath, query);

    const store = openNativeStore({
      baseDir: projectDir,
      fileSearchIncludeTextFiles: true,
      fileSearchScanOnOpen: false,
      fileSearchSchedulerEnabled: false,
      fileSearchSemanticEnabled: false,
    });
    stores.push(store);
    store.fileSearchDb?.scanAndIndex();

    const index = buildFileSearchIndex(store);
    const hits = await index.search(query, { mode: 'hybrid', topK: 5 });
    const chunkResult = await chunkFileContentReady(targetPath, sourceContent);
    const chunks: ChunkReport[] = chunkResult.chunks.map((chunk) => ({
      filePath: chunk.filePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      source: (chunk as unknown as { source?: string }).source,
      fallbackReason: (chunk as unknown as { fallbackReason?: string | null }).fallbackReason ?? null,
    }));

    const report = {
      query,
      topHitPath: hits[0]?.chunk.filePath,
      indexedTargetPathCount: store.fileSearchDb?.db.prepare('SELECT COUNT(*) AS count FROM indexed_files WHERE path = ?').get(targetPath) as { count: number } | undefined,
      chunks,
    };

    expect(report.query).toBe(query);
    expect(report.topHitPath).toEqual(expect.any(String));
    expect(report.indexedTargetPathCount?.count ?? 0).toBeGreaterThan(0);
    expect(report.chunks.some((chunk) => chunk.filePath === targetPath && typeof chunk.source === 'string')).toBe(true);
    expect(report.chunks.some((chunk) => chunk.filePath === targetPath && 'fallbackReason' in chunk)).toBe(true);
  });
});
