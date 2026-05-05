import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSearchIndex, FileSearchIndexBuilder } from '../src/file-search-index.js';
import { applyQueryBoost, candidateScoreMap, chunkKey, type FileSearchChunkRow } from '../src/file-search-semble.js';
import { openNativeStore } from '../src/store.js';

type Store = ReturnType<typeof openNativeStore>;
type RowSpec = {
  relativePath: string;
  content: string;
  language: string;
  semantic?: boolean;
};

function tempDir(prefix = 'byomem-sprint-58-hybrid-candidate-parity-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function chunk(projectDir: string, relativePath: string, content: string, chunkIndex: number, language: string): FileSearchChunkRow {
  return {
    projectKey: 'project:sprint-58-hybrid-parity',
    filePath: join(projectDir, relativePath),
    content,
    startLine: 1,
    endLine: content.split('\n').length,
    chunkIndex,
    chunkHash: `${relativePath}:${chunkIndex}`,
    language,
  };
}

function relativePaths(projectDir: string, rows: Array<{ chunk: { filePath: string } }>): string[] {
  return rows.map((row) => row.chunk.filePath.slice(projectDir.length + 1));
}

async function buildHybridHarness(
  specs: RowSpec[],
): Promise<{ index: FileSearchIndex; projectDir: string; rows: FileSearchChunkRow[]; runtimeDir: string; store: Store }> {
  const projectDir = tempDir();
  const runtimeDir = tempDir('byomem-sprint-58-hybrid-candidate-parity-runtime-');
  const store = openNativeStore({
    baseDir: projectDir,
    fileSearchDbBaseDir: runtimeDir,
    fileSearchScanOnOpen: false,
    fileSearchSchedulerEnabled: false,
    fileSearchSemanticEnabled: true,
    fileSearchIncludeTextFiles: true,
  });

  const rows = specs.map((spec, chunkIndex) => chunk(projectDir, spec.relativePath, spec.content, chunkIndex, spec.language));
  const indexedRows = rows.map((row) => ({ ...row, searchText: row.content }));
  const index = FileSearchIndexBuilder.fromPath(projectDir).build(store);
  vi.spyOn(store.fileSearchDb!, 'embedQuery').mockResolvedValue([1, 0]);
  const vectors = new Map(
    rows
      .filter((_, index) => specs[index]?.semantic)
      .map((row, index) => [chunkKey(row), { vector: index === 0 ? [1, 0] : [0.9, 0.1], dimension: 2 }]),
  );

  (index as { hydrate: () => unknown }).hydrate = () => ({
    rows: indexedRows,
    vectors,
    perLanguageCounts: indexedRows.reduce<Record<string, number>>((counts, row) => {
      counts[row.language ?? 'text'] = (counts[row.language ?? 'text'] ?? 0) + 1;
      return counts;
    }, {}),
    indexedFiles: new Set(indexedRows.map((row) => row.filePath)).size,
    revision: store.fileSearchDb!.indexRevision,
    source: 'memory',
    hydrateStartedAt: new Date(0).toISOString(),
    hydratedAt: new Date(0).toISOString(),
    hydrateMs: 0,
  });

  return { index, projectDir, rows, runtimeDir, store };
}

describe('Sprint 58 file-search hybrid candidate parity', () => {
  const dirs: string[] = [];
  const stores: Store[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    while (stores.length) stores.pop()?.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('forms hybrid candidates only from ranked BM25 and semantic rows, not allRows-only path matches', async () => {
    const harness = await buildHybridHarness([
      {
        relativePath: 'src/register-route.ts',
        content: 'export function registerRoute() { return buildRoute(); }',
        language: 'typescript',
        semantic: true,
      },
      {
        relativePath: 'src/route-registry.ts',
        content: 'export function registerRouteRegistry() { return registerRoute(); }',
        language: 'typescript',
      },
      {
        relativePath: 'docs/register-route-overview.md',
        content: 'overview only',
        language: 'markdown',
      },
    ]);

    dirs.push(harness.projectDir, harness.runtimeDir);
    stores.push(harness.store);

    const hits = await harness.index.search('register route', { mode: 'hybrid', topK: 3 });

    expect(relativePaths(harness.projectDir, hits)).toEqual([
      'src/register-route.ts',
      'src/route-registry.ts',
    ]);
  });

  it('does not let boostStemMatches inject a row that never had a ranked candidate score', () => {
    const projectDir = tempDir();
    dirs.push(projectDir);
    const implementation = chunk(projectDir, 'src/register-route.ts', 'export function registerRoute() { return true; }', 0, 'typescript');
    const docsOnly = chunk(projectDir, 'docs/register-route-overview.md', 'overview only', 1, 'markdown');
    const scores = new Map([[chunkKey(implementation), 0.25]]);
    const chunks = candidateScoreMap([implementation, docsOnly]);

    const boosted = applyQueryBoost(scores, 'register route', chunks);

    expect(boosted.has(chunkKey(docsOnly))).toBe(false);
    expect([...boosted.keys()]).toEqual([chunkKey(implementation)]);
  });

  it('keeps implementation definitions ahead of natural-language path matches that were never ranked candidates', async () => {
    const harness = await buildHybridHarness([
      {
        relativePath: 'src/register-route.ts',
        content: 'export function registerRoute() { return buildRoute(); }',
        language: 'typescript',
        semantic: true,
      },
      {
        relativePath: 'src/route-registry.ts',
        content: 'export function registerRouteRegistry() { return registerRoute(); }',
        language: 'typescript',
      },
      {
        relativePath: 'docs/register-route-overview.md',
        content: 'overview only',
        language: 'markdown',
      },
    ]);

    dirs.push(harness.projectDir, harness.runtimeDir);
    stores.push(harness.store);

    const hits = await harness.index.search('register route', { mode: 'hybrid', topK: 2 });

    expect(relativePaths(harness.projectDir, hits)).toEqual([
      'src/register-route.ts',
      'src/route-registry.ts',
    ]);
  });
});
