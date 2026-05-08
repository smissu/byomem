import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { openFileSearchDb } from '../src/file-search-db.js';
import { openGraphDb } from '../src/graph-db.js';
import { registerOperationsTools } from '../src/mcp/operations-tools.js';

type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown> | unknown;
};

function tempDir(prefix = 'byomem-sprint-65-mcp-cli-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

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
        { id: 'import:node:path', label: 'node:path', sourceFile: 'src/alpha.ts', sourceLocation: 'L1', kind: 'import' },
      ],
      edges: [
        { source: 'file:src/alpha.ts', target: 'src/alpha.ts:alphaRoute:1', relation: 'contains', sourceFile: 'src/alpha.ts', sourceLocation: 'L1' },
        { source: 'file:src/alpha.ts', target: 'import:node:path', relation: 'imports_from', sourceFile: 'src/alpha.ts', sourceLocation: 'L1' },
      ],
    });
  } finally {
    graphDb.close();
  }
}

function stripGraph(results: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return results.map(({ graph: _graph, ...result }) => result);
}

function makeRuntimeContext(runtimeDir: string) {
  return {
    runtimeBaseDir: runtimeDir,
    nativeStore: {},
    embeddingConfig: { source: 'default' },
    fileSearchConfig: {
      source: 'default',
      indexStorageMode: 'disk',
      includeTextFiles: false,
      excludedExtensions: [],
      binaryDetectionEnabled: true,
    },
  };
}

describe('Sprint 65 file-search graph context MCP and CLI surfaces', () => {
  const dirs: string[] = [];
  const originalRuntimeBase = process.env.BYOMEM_RUNTIME_BASE_DIR;

  afterEach(() => {
    vi.restoreAllMocks();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    if (originalRuntimeBase === undefined) delete process.env.BYOMEM_RUNTIME_BASE_DIR;
    else process.env.BYOMEM_RUNTIME_BASE_DIR = originalRuntimeBase;
  });

  it('keeps CLI default output unchanged and adds graph only for --include-graph', async () => {
    const runtimeDir = tempDir('byomem-sprint-65-runtime-');
    const projectDir = tempDir('byomem-sprint-65-project-');
    dirs.push(runtimeDir, projectDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    seedProject(runtimeDir, projectDir);

    const cliSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['file-search', '--base-dir', projectDir, '--query', 'alphaRoute', '--mode', 'bm25', '--limit', '1', '--json']);
    const defaultPayload = JSON.parse(String(cliSpy.mock.calls.at(-1)?.[0] ?? '{}')) as { results: Array<Record<string, unknown>> };
    expect(defaultPayload.results[0]).not.toHaveProperty('graph');

    cliSpy.mockClear();
    await main(['file-search', '--base-dir', projectDir, '--query', 'alphaRoute', '--mode', 'bm25', '--limit', '1', '--include-graph', '--json']);
    const graphPayload = JSON.parse(String(cliSpy.mock.calls.at(-1)?.[0] ?? '{}')) as { results: Array<Record<string, any>> };

    expect(stripGraph(graphPayload.results)).toEqual(defaultPayload.results);
    expect(graphPayload.results[0]?.graph).toMatchObject({
      available: true,
      fileNode: { id: 'file:src/alpha.ts' },
      nearestSymbols: [{ id: 'src/alpha.ts:alphaRoute:1' }],
      importsFrom: ['node:path'],
    });
  });

  it('accepts MCP includeGraph and preserves default result shape when omitted', async () => {
    const runtimeDir = tempDir('byomem-sprint-65-runtime-');
    const projectDir = tempDir('byomem-sprint-65-project-');
    dirs.push(runtimeDir, projectDir);
    seedProject(runtimeDir, projectDir);

    const tools: RegisteredTool[] = [];
    registerOperationsTools({
      registerTool(name: string, _meta: unknown, execute: RegisteredTool['execute']) {
        tools.push({ name, execute: (_toolCallId: string, params: Record<string, unknown>) => execute(params) });
      },
    } as never, () => makeRuntimeContext(runtimeDir) as never);

    const searchTool = tools.find((tool) => tool.name === 'byomem_file_search');
    expect(searchTool).toBeDefined();

    const defaultRaw = await searchTool!.execute('default', { baseDir: projectDir, query: 'alphaRoute', mode: 'bm25', limit: 1 });
    const defaultPayload = JSON.parse(String((defaultRaw as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '{}')) as { results: Array<Record<string, unknown>> };
    expect(defaultPayload.results[0]).not.toHaveProperty('graph');

    const graphRaw = await searchTool!.execute('graph', { baseDir: projectDir, query: 'alphaRoute', mode: 'bm25', limit: 1, includeGraph: true });
    const graphPayload = JSON.parse(String((graphRaw as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '{}')) as { results: Array<Record<string, any>> };

    expect(stripGraph(graphPayload.results)).toEqual(defaultPayload.results);
    expect(graphPayload.results[0]?.graph).toMatchObject({
      available: true,
      fileNode: { id: 'file:src/alpha.ts' },
      nearestSymbols: [{ id: 'src/alpha.ts:alphaRoute:1' }],
    });
  });
});
