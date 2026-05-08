import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openFileSearchDb } from '../src/file-search-db.js';
import { openGraphDb } from '../src/graph-db.js';
import {
  disposeMockPi,
  loadExtension,
  makeMockPi,
  requireRegisteredTool,
  tempDir,
  type MockPi,
} from './helpers/pi-extension-test-utils.js';

function seedProject(runtimeDir: string, projectDir: string): void {
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  writeFileSync(join(projectDir, 'src', 'alpha.ts'), 'export function alphaRoute() {\n  return 1;\n}\n', 'utf8');
  const fileDb = openFileSearchDb({
    baseDir: projectDir,
    dbBaseDir: runtimeDir,
    scanOnOpen: true,
    schedulerEnabled: false,
    semanticSearchEnabled: false,
  });
  fileDb.close();

  const graphDb = openGraphDb({ baseDir: projectDir, dbBaseDir: runtimeDir });
  try {
    graphDb.importGraph({
      source: 'sprint-65-fixture',
      baseDir: projectDir,
      nodes: [
        { id: 'file:src/alpha.ts', label: 'src/alpha.ts', sourceFile: 'src/alpha.ts', sourceLocation: 'L1', kind: 'file' },
        { id: 'src/alpha.ts:alphaRoute:1', label: 'alphaRoute()', sourceFile: 'src/alpha.ts', sourceLocation: 'L1', kind: 'symbol' },
      ],
      edges: [
        { source: 'file:src/alpha.ts', target: 'src/alpha.ts:alphaRoute:1', relation: 'contains', sourceFile: 'src/alpha.ts', sourceLocation: 'L1' },
      ],
    });
  } finally {
    graphDb.close();
  }
}

function stripGraph(results: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return results.map(({ graph: _graph, ...result }) => result);
}

describe('Sprint 65 file-search graph context Pi extension surface', () => {
  const dirs: string[] = [];
  const mockPis: MockPi[] = [];

  afterEach(async () => {
    while (mockPis.length) await disposeMockPi(mockPis.pop()!);
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('registers includeGraph on the strict direct file-search schema', async () => {
    const mod = await loadExtension();
    const mock = makeMockPi();
    mockPis.push(mock);
    mod.default(mock.api as never);

    expect(requireRegisteredTool(mock, 'byomem_file_search').parameters).toMatchObject({
      properties: {
        includeGraph: { type: 'boolean' },
      },
      additionalProperties: false,
    });
  });

  it('adds Pi graph context only when includeGraph is true', async () => {
    const runtimeDir = tempDir('byomem-sprint-65-pi-runtime-');
    const projectDir = tempDir('byomem-sprint-65-pi-project-');
    dirs.push(runtimeDir, projectDir);
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', runtimeDir);
    seedProject(runtimeDir, projectDir);

    const mod = await loadExtension();
    const mock = makeMockPi();
    mockPis.push(mock);
    mod.default(mock.api as never);

    const searchTool = requireRegisteredTool(mock, 'byomem_file_search');
    const defaultPayload = await searchTool.execute('default', { baseDir: projectDir, query: 'alphaRoute', mode: 'bm25', limit: 1 }) as {
      results: Array<Record<string, unknown>>;
    };
    expect(defaultPayload.results[0]).not.toHaveProperty('graph');

    const graphPayload = await searchTool.execute('graph', { baseDir: projectDir, query: 'alphaRoute', mode: 'bm25', limit: 1, includeGraph: true }) as {
      results: Array<Record<string, any>>;
    };
    expect(stripGraph(graphPayload.results)).toEqual(defaultPayload.results);
    expect(graphPayload.results[0]?.graph).toMatchObject({
      available: true,
      fileNode: { id: 'file:src/alpha.ts' },
      nearestSymbols: [{ id: 'src/alpha.ts:alphaRoute:1' }],
    });
  });

  it('validates includeGraph as a boolean', async () => {
    const projectDir = tempDir('byomem-sprint-65-pi-project-');
    dirs.push(projectDir);
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    const mod = await loadExtension();
    const mock = makeMockPi();
    mockPis.push(mock);
    mod.default(mock.api as never);

    const searchTool = requireRegisteredTool(mock, 'byomem_file_search');
    await expect(searchTool.execute('invalid', { query: 'alphaRoute', includeGraph: 'true' })).rejects.toThrow(/includeGraph/i);
  });
});
