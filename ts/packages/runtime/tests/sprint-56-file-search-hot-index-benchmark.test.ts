import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fixtures from './sprint-50-embedding-fixtures.json';
import { buildFileSearchIndex } from '../src/file-search-index.js';
import { openNativeStore } from '../src/store.js';

type Store = ReturnType<typeof openNativeStore>;

interface HotIndexBenchmarkReport {
  scanMs: number;
  refreshMs: number;
  hydrateMs: number;
  warmBm25Ms: number;
  warmSemanticMs: number;
  warmHybridMs: number;
  mcpWallMs?: number;
  chunkCount: number;
  embeddingState: string;
  hotIndexState?: string;
  model: string;
  providerKey: string;
  configuredDimension: number;
}

function tempDir(prefix = 'byomem-sprint-56-hot-index-benchmark-'): string {
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

function makeVector(head: number[], dimension = 768): number[] {
  const vector = new Array<number>(dimension).fill(0);
  head.forEach((value, index) => {
    vector[index] = value;
  });
  return vector;
}

function mockEmbeddings(): { restore: () => void } {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { prompt?: string; input?: string };
    const text = `${body.prompt ?? ''} ${body.input ?? ''}`.toLowerCase();
    let embedding = makeVector([0.1, 0.1, 0.8]);
    if (text.includes('depends') || text.includes('dependency') || text.includes('routes') || text.includes('param_functions')) embedding = makeVector([1, 0, 0]);
    if (text.includes('validation') || text.includes('error handling')) embedding = makeVector([0, 1, 0]);
    if (text.includes('wsgi') || text.includes('docs page')) embedding = makeVector([0, 0, 1]);
    return new Response(JSON.stringify({ embedding }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

async function timed<T>(fn: () => Promise<T> | T): Promise<{ value: T; elapsedMs: number }> {
  const startedAt = performance.now();
  const value = await fn();
  return { value, elapsedMs: performance.now() - startedAt };
}

async function collectHotIndexBenchmarkReport(): Promise<HotIndexBenchmarkReport> {
  const overallStartedAt = performance.now();
  const runtimeDir = tempDir('byomem-sprint-56-runtime-');
  const projectDir = tempDir('byomem-sprint-56-project-');
  const originalRuntimeBase = process.env.BYOMEM_RUNTIME_BASE_DIR;
  const embeddingMock = mockEmbeddings();
  let storeA: Store | undefined;
  let storeB: Store | undefined;

  try {
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    buildFastApiFixture(projectDir);

    storeA = openNativeStore({
      baseDir: projectDir,
      fileSearchDbBaseDir: runtimeDir,
      fileSearchIncludeTextFiles: true,
      fileSearchScanOnOpen: false,
      fileSearchSchedulerEnabled: false,
      fileSearchSemanticEnabled: true,
      embeddingBaseUrl: 'http://localhost:11434',
      embeddingModel: fixtures.activeEmbeddingIdentity.model,
      embeddingDimension: fixtures.activeEmbeddingIdentity.dimension,
      embeddingRequireRemote: true,
    });

    const scan = await timed(() => storeA!.fileSearchDb!.scanAndIndex());
    const refresh = await timed(() => storeA!.fileSearchDb!.refreshSemanticIndex());
    const refreshedDiagnostics = storeA.fileSearchDb!.getEmbeddingDiagnostics();
    expect(refreshedDiagnostics.state).toBe('ready');

    storeA.close();
    storeA = undefined;

    storeB = openNativeStore({
      baseDir: projectDir,
      fileSearchDbBaseDir: runtimeDir,
      fileSearchIncludeTextFiles: true,
      fileSearchScanOnOpen: false,
      fileSearchSchedulerEnabled: false,
      fileSearchSemanticEnabled: true,
      embeddingBaseUrl: 'http://localhost:11434',
      embeddingModel: fixtures.activeEmbeddingIdentity.model,
      embeddingDimension: fixtures.activeEmbeddingIdentity.dimension,
      embeddingRequireRemote: true,
    });

    const hydrateStartedAt = performance.now();
    const index = buildFileSearchIndex(storeB);
    const stats = index.stats();
    const hydrateMs = performance.now() - hydrateStartedAt;

    const warmBm25 = await timed(() => index.search('Depends', { mode: 'bm25', topK: 5 }));
    const warmSemantic = await timed(() => index.search(fixtures.querySet[0], { mode: 'semantic', topK: 5 }));
    const warmHybrid = await timed(() => index.search(fixtures.querySet[1], { mode: 'hybrid', topK: 5 }));
    const embedding = storeB.fileSearchDb!.getEmbeddingDiagnostics();
    const hotIndexState = (stats as unknown as { hotIndex?: { state?: string } }).hotIndex?.state;

    return {
      scanMs: scan.elapsedMs,
      refreshMs: refresh.elapsedMs,
      hydrateMs,
      warmBm25Ms: warmBm25.elapsedMs,
      warmSemanticMs: warmSemantic.elapsedMs,
      warmHybridMs: warmHybrid.elapsedMs,
      mcpWallMs: performance.now() - overallStartedAt,
      chunkCount: stats.index.chunkCount,
      embeddingState: embedding.state,
      hotIndexState,
      model: embedding.model,
      providerKey: embedding.providerKey,
      configuredDimension: embedding.configuredDimension,
    };
  } finally {
    storeB?.close();
    storeA?.close();
    embeddingMock.restore();
    if (originalRuntimeBase === undefined) delete process.env.BYOMEM_RUNTIME_BASE_DIR;
    else process.env.BYOMEM_RUNTIME_BASE_DIR = originalRuntimeBase;
    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
}

describe('Sprint 56 hot-index benchmark RED harness', () => {
  afterEach(() => {
    if (process.env.BYOMEM_RUNTIME_BASE_DIR === undefined) return;
    delete process.env.BYOMEM_RUNTIME_BASE_DIR;
  });

  it('reports the hot-index benchmark timings and lifecycle fields for the hot in-process index', async () => {
    const report = await collectHotIndexBenchmarkReport();

    expect(report).toMatchObject({
      scanMs: expect.any(Number),
      refreshMs: expect.any(Number),
      hydrateMs: expect.any(Number),
      warmBm25Ms: expect.any(Number),
      warmSemanticMs: expect.any(Number),
      warmHybridMs: expect.any(Number),
      mcpWallMs: expect.any(Number),
      chunkCount: expect.any(Number),
      embeddingState: 'ready',
      hotIndexState: 'ready',
      model: fixtures.activeEmbeddingIdentity.model,
      providerKey: fixtures.activeEmbeddingIdentity.providerKey,
      configuredDimension: fixtures.activeEmbeddingIdentity.dimension,
    });
    expect(report.chunkCount).toBeGreaterThan(0);
  });
});
