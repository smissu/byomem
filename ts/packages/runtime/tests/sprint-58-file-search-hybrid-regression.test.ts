import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSearchIndexBuilder } from '../src/file-search-index.js';
import { applyQueryBoost, candidateScoreMap, chunkKey, rerankTopK, type FileSearchChunkRow } from '../src/file-search-semble.js';
import { openNativeStore } from '../src/store.js';

type Store = ReturnType<typeof openNativeStore>;
type RowSpec = {
  relativePath: string;
  content: string;
  language: string;
  semantic?: boolean;
};

function tempDir(prefix = 'byomem-sprint-58-hybrid-regression-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function chunk(projectDir: string, relativePath: string, content: string, chunkIndex: number, language: string): FileSearchChunkRow {
  return {
    projectKey: 'project:sprint-58-hybrid-regression',
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

async function buildHybridHarness(specs: RowSpec[]) {
  const projectDir = tempDir();
  const runtimeDir = tempDir('byomem-sprint-58-hybrid-regression-runtime-');
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
      .map((row, semanticIndex) => [chunkKey(row), { vector: semanticIndex === 0 ? [1, 0] : [0.9, 0.1], dimension: 2 }]),
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

  return { index, projectDir, runtimeDir, store };
}

describe('Sprint 58 file-search hybrid regression lock suite', () => {
  const dirs: string[] = [];
  const stores: Store[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    while (stores.length) stores.pop()?.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('keeps hybrid ranking limited to bm25/semantic candidates even when allRows contains a stronger path-only match', async () => {
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

  it('does not let stem boosts inject non-candidate rows back into the candidate set', () => {
    const projectDir = tempDir();
    dirs.push(projectDir);
    const implementation = chunk(projectDir, 'src/register-route.ts', 'export function registerRoute() { return true; }', 0, 'typescript');
    const docsOnly = chunk(projectDir, 'docs/register-route-overview.md', 'overview only', 1, 'markdown');
    const candidateRows = candidateScoreMap([implementation]);
    const allRows = candidateScoreMap([implementation, docsOnly]);
    const boosted = applyQueryBoost(new Map([[chunkKey(implementation), 0.25]]), 'register route', candidateRows, allRows);

    expect(boosted.has(chunkKey(docsOnly))).toBe(false);
    expect(candidateRows.has(chunkKey(docsOnly))).toBe(false);
    expect([...boosted.keys()]).toEqual([chunkKey(implementation)]);
  });

  it('requires definitionTier before embedded symbol boosts can raise or inject a row', () => {
    const projectDir = tempDir();
    dirs.push(projectDir);
    const definition = chunk(
      projectDir,
      'src/refreshSemanticIndex.ts',
      [
        'export async function refreshSemanticIndex() {',
        '  return true;',
        '}',
      ].join('\n'),
      0,
      'typescript',
    );
    const referenceOnly = chunk(
      projectDir,
      'src/refresh-worker.ts',
      [
        'const invokeRefresh = () => refreshSemanticIndex();',
        'export function scheduleRefresh() {',
        '  return invokeRefresh();',
        '}',
      ].join('\n'),
      1,
      'typescript',
    );
    const nonCandidateReference = chunk(
      projectDir,
      'src/refreshSemanticIndex-worker.ts',
      'const invokeRefresh = () => refreshSemanticIndex();',
      2,
      'typescript',
    );
    const candidateRows = candidateScoreMap([definition, referenceOnly]);
    const allRows = candidateScoreMap([definition, referenceOnly, nonCandidateReference]);
    const boosted = applyQueryBoost(
      new Map<string, number>([
        [chunkKey(definition), 0.4],
        [chunkKey(referenceOnly), 0.35],
      ]),
      'why refreshSemanticIndex stalls',
      candidateRows,
      allRows,
    );

    expect(boosted.get(chunkKey(definition))).toBeCloseTo(1.3, 6);
    expect(boosted.get(chunkKey(referenceOnly))).toBeCloseTo(0.35, 6);
    expect(boosted.has(chunkKey(nonCandidateReference))).toBe(false);
    expect(candidateRows.has(chunkKey(nonCandidateReference))).toBe(false);
  });

  it('keeps rerank ordering deterministic for equal final scores', () => {
    const alphaLater = chunk('/tmp', 'src/alpha.ts', 'export const later = true;', 2, 'typescript');
    const beta = chunk('/tmp', 'src/beta.ts', 'export const beta = true;', 0, 'typescript');
    const alphaEarlier = chunk('/tmp', 'src/alpha.ts', 'export const earlier = true;', 0, 'typescript');
    const expected = [
      { key: chunkKey(alphaEarlier), filePath: alphaEarlier.filePath, chunkIndex: 0, score: 5 },
      { key: chunkKey(beta), filePath: beta.filePath, chunkIndex: 0, score: 5 },
      { key: chunkKey(alphaLater), filePath: alphaLater.filePath, chunkIndex: 2, score: 2.5 },
    ];

    const reruns = [
      [beta, alphaLater, alphaEarlier],
      [alphaEarlier, beta, alphaLater],
      [alphaLater, alphaEarlier, beta],
    ].map((rows) => {
      const chunks = candidateScoreMap(rows);
      const scores = new Map(rows.map((row) => [chunkKey(row), 5]));
      return rerankTopK(scores, chunks, rows.length, false, 'refresh active poller status').map(({ chunk, score }) => ({
        key: chunkKey(chunk),
        filePath: chunk.filePath,
        chunkIndex: chunk.chunkIndex,
        score,
      }));
    });

    expect(reruns).toEqual([expected, expected, expected]);
  });
});
