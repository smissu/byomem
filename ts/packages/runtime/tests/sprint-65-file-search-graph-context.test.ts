import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { enrichFileSearchHitsWithGraph } from '../src/file-search-graph-context.js';
import { openGraphDb, type GraphDbHandle } from '../src/graph-db.js';

type SerializedHit = {
  score?: number;
  source?: string;
  chunk?: {
    filePath?: string;
    content?: string;
    startLine?: number;
    endLine?: number;
    language?: string;
  };
};

function tempDir(prefix = 'byomem-sprint-65-graph-context-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function stripGraph(hits: Array<SerializedHit & { graph?: unknown }>): SerializedHit[] {
  return hits.map(({ graph: _graph, ...hit }) => hit);
}

function seedGraph(graphDb: GraphDbHandle, baseDir: string): void {
  graphDb.importGraph({
    source: 'sprint-65-fixture',
    baseDir,
    nodes: [
      { id: 'file:src/alpha.ts', label: 'src/alpha.ts', fileType: 'code', sourceFile: 'src/alpha.ts', sourceLocation: 'L1', kind: 'file' },
      { id: 'src/alpha.ts:beforeAlpha:10', label: 'beforeAlpha()', fileType: 'code', sourceFile: 'src/alpha.ts', sourceLocation: 'L10', kind: 'symbol' },
      { id: 'src/alpha.ts:insideAlpha:20', label: 'insideAlpha()', fileType: 'code', sourceFile: 'src/alpha.ts', sourceLocation: 'L20', kind: 'symbol' },
      { id: 'src/alpha.ts:afterAlpha:30', label: 'afterAlpha()', fileType: 'code', sourceFile: 'src/alpha.ts', sourceLocation: 'L30', kind: 'symbol' },
      { id: 'src/alpha.ts:malformed', label: 'malformedAlpha()', fileType: 'code', sourceFile: 'src/alpha.ts', sourceLocation: 'line unknown', kind: 'symbol' },
      { id: 'import:node:path', label: 'node:path', fileType: 'code', sourceFile: 'src/alpha.ts', sourceLocation: 'L1', kind: 'import' },
      { id: 'file:src/beta.ts', label: 'beta-by-label.ts', fileType: 'code', sourceFile: 'src/beta.ts', sourceLocation: 'L1', kind: 'file' },
      { id: 'src/beta.ts:betaRoute:4', label: 'betaRoute()', fileType: 'code', sourceFile: 'src/beta.ts', sourceLocation: 'L4', kind: 'symbol' },
      { id: 'label-only-gamma', label: 'src/gamma.ts', fileType: 'code', sourceLocation: 'L1', kind: 'file' },
      { id: 'src/gamma.ts:gammaRoute:8', label: 'gammaRoute()', fileType: 'code', sourceFile: 'src/gamma.ts', sourceLocation: 'L8', kind: 'symbol' },
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `import:pkg-${index}`,
        label: `pkg-${index}`,
        fileType: 'code',
        sourceFile: 'src/alpha.ts',
        sourceLocation: `L${index + 2}`,
        kind: 'import',
      })),
    ],
    edges: [
      { source: 'file:src/alpha.ts', target: 'src/alpha.ts:beforeAlpha:10', relation: 'contains', sourceFile: 'src/alpha.ts', sourceLocation: 'L10' },
      { source: 'file:src/alpha.ts', target: 'src/alpha.ts:insideAlpha:20', relation: 'contains', sourceFile: 'src/alpha.ts', sourceLocation: 'L20' },
      { source: 'file:src/alpha.ts', target: 'src/alpha.ts:afterAlpha:30', relation: 'contains', sourceFile: 'src/alpha.ts', sourceLocation: 'L30' },
      { source: 'file:src/alpha.ts', target: 'import:node:path', relation: 'imports_from', sourceFile: 'src/alpha.ts', sourceLocation: 'L1' },
      { source: 'file:src/beta.ts', target: 'src/beta.ts:betaRoute:4', relation: 'contains', sourceFile: 'src/beta.ts', sourceLocation: 'L4' },
      { source: 'label-only-gamma', target: 'src/gamma.ts:gammaRoute:8', relation: 'contains', sourceFile: 'src/gamma.ts', sourceLocation: 'L8' },
      ...Array.from({ length: 12 }, (_, index) => ({
        source: 'file:src/alpha.ts',
        target: `import:pkg-${index}`,
        relation: 'imports_from',
        sourceFile: 'src/alpha.ts',
        sourceLocation: `L${index + 2}`,
      })),
    ],
  });
}

function trackGraphNodeSelects(graphDb: GraphDbHandle) {
  const handle = graphDb as { db: Record<string, unknown> };
  const originalDb = handle.db;
  const originalPrepare = (originalDb.prepare as (...args: unknown[]) => unknown).bind(originalDb);
  let fileNodeSelectCount = 0;
  const proxyDb = new Proxy(originalDb, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return ((sql: string, ...args: unknown[]) => {
          const statement = originalPrepare(sql, ...args);
          if (typeof sql === 'string' && sql.includes('/* file-search-graph:file-node */')) fileNodeSelectCount += 1;
          return statement;
        }) as never;
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  handle.db = proxyDb;
  return {
    get count(): number {
      return fileNodeSelectCount;
    },
    restore(): void {
      handle.db = originalDb;
    },
  };
}

describe('Sprint 65 file-search graph context helper', () => {
  const dirs: string[] = [];
  const handles: GraphDbHandle[] = [];

  afterEach(() => {
    while (handles.length) handles.pop()?.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('enriches serialized hits with deterministic bounded graph context without changing base hit data', async () => {
    const baseDir = tempDir();
    const runtimeDir = tempDir();
    dirs.push(baseDir, runtimeDir);
    const writableGraph = openGraphDb({ baseDir, dbBaseDir: runtimeDir });
    handles.push(writableGraph);
    seedGraph(writableGraph, baseDir);
    writableGraph.close();
    handles.pop();

    const readonlyGraph = openGraphDb({ baseDir, dbBaseDir: runtimeDir, readonly: true });
    handles.push(readonlyGraph);
    const hits: SerializedHit[] = [
      {
        score: 0.9,
        source: 'hybrid',
        chunk: {
          filePath: join(baseDir, 'src', 'alpha.ts'),
          content: 'alpha body',
          startLine: 18,
          endLine: 22,
          language: 'typescript',
        },
      },
      {
        score: 0.8,
        source: 'bm25',
        chunk: {
          filePath: 'src/beta.ts/',
          content: 'beta body',
          startLine: 4,
          endLine: 4,
        },
      },
      {
        score: 0.7,
        source: 'bm25',
        chunk: {
          filePath: resolve(baseDir, '..', 'outside.ts'),
          content: 'outside body',
          startLine: 1,
          endLine: 1,
        },
      },
    ];
    const before = structuredClone(hits);

    const enriched = await enrichFileSearchHitsWithGraph(hits, { baseDir: `${baseDir}/`, graphDb: readonlyGraph });

    expect(stripGraph(enriched)).toEqual(before);
    expect(enriched[0]?.graph).toEqual({
      available: true,
      fileNode: { id: 'file:src/alpha.ts', label: 'src/alpha.ts', sourceFile: 'src/alpha.ts', sourceLocation: 'L1', kind: 'file' },
      nearestSymbols: [
        { id: 'src/alpha.ts:insideAlpha:20', label: 'insideAlpha()', sourceFile: 'src/alpha.ts', sourceLocation: 'L20', kind: 'symbol' },
        { id: 'src/alpha.ts:beforeAlpha:10', label: 'beforeAlpha()', sourceFile: 'src/alpha.ts', sourceLocation: 'L10', kind: 'symbol' },
        { id: 'src/alpha.ts:afterAlpha:30', label: 'afterAlpha()', sourceFile: 'src/alpha.ts', sourceLocation: 'L30', kind: 'symbol' },
      ],
      importsFrom: ['node:path', 'pkg-0', 'pkg-1', 'pkg-10', 'pkg-11', 'pkg-2', 'pkg-3', 'pkg-4', 'pkg-5', 'pkg-6'],
      relations: [
        { source: 'file:src/alpha.ts', target: 'src/alpha.ts:afterAlpha:30', relation: 'contains', sourceFile: 'src/alpha.ts', sourceLocation: 'L30' },
        { source: 'file:src/alpha.ts', target: 'src/alpha.ts:beforeAlpha:10', relation: 'contains', sourceFile: 'src/alpha.ts', sourceLocation: 'L10' },
        { source: 'file:src/alpha.ts', target: 'src/alpha.ts:insideAlpha:20', relation: 'contains', sourceFile: 'src/alpha.ts', sourceLocation: 'L20' },
        { source: 'file:src/alpha.ts', target: 'import:node:path', relation: 'imports_from', sourceFile: 'src/alpha.ts', sourceLocation: 'L1' },
        { source: 'file:src/alpha.ts', target: 'import:pkg-0', relation: 'imports_from', sourceFile: 'src/alpha.ts', sourceLocation: 'L2' },
        { source: 'file:src/alpha.ts', target: 'import:pkg-1', relation: 'imports_from', sourceFile: 'src/alpha.ts', sourceLocation: 'L3' },
        { source: 'file:src/alpha.ts', target: 'import:pkg-10', relation: 'imports_from', sourceFile: 'src/alpha.ts', sourceLocation: 'L12' },
        { source: 'file:src/alpha.ts', target: 'import:pkg-11', relation: 'imports_from', sourceFile: 'src/alpha.ts', sourceLocation: 'L13' },
        { source: 'file:src/alpha.ts', target: 'import:pkg-2', relation: 'imports_from', sourceFile: 'src/alpha.ts', sourceLocation: 'L4' },
        { source: 'file:src/alpha.ts', target: 'import:pkg-3', relation: 'imports_from', sourceFile: 'src/alpha.ts', sourceLocation: 'L5' },
      ],
    });
    expect(enriched[1]?.graph).toMatchObject({
      available: true,
      fileNode: { id: 'file:src/beta.ts', label: 'beta-by-label.ts', sourceFile: 'src/beta.ts' },
      nearestSymbols: [{ id: 'src/beta.ts:betaRoute:4', label: 'betaRoute()' }],
    });
    expect(enriched[2]?.graph).toEqual({ available: false });
  });

  it('resolves file nodes by label fallback and honors payload limit overrides', async () => {
    const baseDir = tempDir();
    const runtimeDir = tempDir();
    dirs.push(baseDir, runtimeDir);
    const graphDb = openGraphDb({ baseDir, dbBaseDir: runtimeDir });
    handles.push(graphDb);
    seedGraph(graphDb, baseDir);

    const enriched = await enrichFileSearchHitsWithGraph([
      { chunk: { filePath: 'src/gamma.ts', startLine: 8, endLine: 8 } },
      { chunk: { filePath: 'src/alpha.ts', startLine: 1, endLine: 1 } },
    ], {
      baseDir,
      graphDb,
      limits: { nearestSymbols: 1, importsFrom: 2, relations: 2 },
    });

    expect(enriched[0]?.graph).toMatchObject({
      available: true,
      fileNode: { id: 'label-only-gamma', label: 'src/gamma.ts' },
      nearestSymbols: [{ id: 'src/gamma.ts:gammaRoute:8' }],
    });
    expect(enriched[1]?.graph).toMatchObject({
      available: true,
      nearestSymbols: [{ id: 'src/alpha.ts:beforeAlpha:10' }],
      importsFrom: ['node:path', 'pkg-0'],
    });
    expect((enriched[1]?.graph as { relations?: unknown[] }).relations).toHaveLength(2);
  });

  it('memoizes per-file graph lookups within one enrichment request', async () => {
    const baseDir = tempDir();
    const runtimeDir = tempDir();
    dirs.push(baseDir, runtimeDir);
    const graphDb = openGraphDb({ baseDir, dbBaseDir: runtimeDir });
    handles.push(graphDb);
    seedGraph(graphDb, baseDir);
    const tracker = trackGraphNodeSelects(graphDb);

    try {
      const enriched = await enrichFileSearchHitsWithGraph([
        { chunk: { filePath: join(baseDir, 'src', 'alpha.ts'), startLine: 18, endLine: 22 } },
        { chunk: { filePath: 'src/alpha.ts', startLine: 30, endLine: 30 } },
      ], { baseDir, graphDb });

      expect(enriched.every((hit) => hit.graph?.available === true)).toBe(true);
      expect(tracker.count).toBe(1);
    } finally {
      tracker.restore();
    }
  });

  it('returns unavailable graph blocks for nonexistent, malformed, or empty graph data without throwing', async () => {
    const baseDir = tempDir();
    const runtimeDir = tempDir();
    const malformedRuntimeDir = tempDir();
    dirs.push(baseDir, runtimeDir, malformedRuntimeDir);
    writeFileSync(join(malformedRuntimeDir, 'byomem-graph.sqlite'), 'not sqlite', 'utf8');
    const hit: SerializedHit = { chunk: { filePath: 'src/missing.ts', startLine: 1, endLine: 1, content: 'missing' } };

    await expect(enrichFileSearchHitsWithGraph([hit], { baseDir, dbBaseDir: runtimeDir })).resolves.toEqual([
      { ...hit, graph: { available: false } },
    ]);
    await expect(enrichFileSearchHitsWithGraph([hit], { baseDir, dbBaseDir: malformedRuntimeDir })).resolves.toEqual([
      { ...hit, graph: { available: false } },
    ]);

    const emptyGraph = openGraphDb({ baseDir, dbBaseDir: runtimeDir });
    handles.push(emptyGraph);
    await expect(enrichFileSearchHitsWithGraph([hit], { baseDir, graphDb: emptyGraph })).resolves.toEqual([
      { ...hit, graph: { available: false } },
    ]);
  });
});
