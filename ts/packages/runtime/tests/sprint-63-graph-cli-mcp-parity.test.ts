import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { registerOperationsTools } from '../src/mcp/operations-tools.js';
import { registerReadOnlyTools } from '../src/mcp/readonly-tools.js';

type RegisteredTool = {
  name: string;
  execute: (params: Record<string, unknown>) => Promise<unknown> | unknown;
};

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeMockServer(): { tools: RegisteredTool[]; server: { registerTool: (name: string, meta: unknown, execute: (params: Record<string, unknown>) => Promise<unknown> | unknown) => void } } {
  const tools: RegisteredTool[] = [];
  return {
    tools,
    server: {
      registerTool(name: string, _meta: unknown, execute: (params: Record<string, unknown>) => Promise<unknown> | unknown) {
        tools.push({ name, execute });
      },
    },
  };
}

function parseToolPayload(raw: unknown): Record<string, unknown> {
  const text = String((raw as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '{}');
  return JSON.parse(text) as Record<string, unknown>;
}

function writeGraph(projectDir: string): void {
  const graphDir = join(projectDir, 'graphify-out');
  mkdirSync(graphDir, { recursive: true });
  writeFileSync(join(graphDir, 'graph.json'), JSON.stringify({
    directed: true,
    multigraph: true,
    graph: {},
    nodes: [
      { id: 'alpha', label: 'alpha()', file_type: 'code', source_file: 'src/alpha.ts', source_location: 'L1', community: 0, norm_label: 'alpha()' },
      { id: 'beta', label: 'beta()', file_type: 'code', source_file: 'src/beta.ts', source_location: 'L2', community: 0, norm_label: 'beta()' },
    ],
    links: [
      { source: 'alpha', target: 'beta', _src: 'alpha', _tgt: 'beta', relation: 'calls', confidence: 'EXTRACTED', confidence_score: 1, weight: 1, source_file: 'src/alpha.ts', source_location: 'L2' },
    ],
    hyperedges: [],
  }), 'utf8');
  writeFileSync(join(graphDir, 'GRAPH_REPORT.md'), `# Graph Report - fixture  (2026-05-07)

## Corpus Check
- 2 files · ~80 words

## Summary
- 2 nodes · 1 edges · 1 communities detected
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 0 edges (avg confidence: 0)
- Token cost: 0 input · 0 output

## Communities

### Community 0 - "Community 0"
Cohesion: 0.50
Nodes (2): alpha(), beta()
`, 'utf8');
}

describe('Sprint 63 graph CLI/MCP parity', () => {
  const dirs: string[] = [];
  const originalRuntimeBase = process.env.BYOMEM_RUNTIME_BASE_DIR;
  const originalExitCode = process.exitCode;

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = originalExitCode;
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    if (originalRuntimeBase === undefined) delete process.env.BYOMEM_RUNTIME_BASE_DIR;
    else process.env.BYOMEM_RUNTIME_BASE_DIR = originalRuntimeBase;
  });

  it('keeps graph update in operations and graph reads in readonly with matching payloads', async () => {
    const runtimeDir = tempDir('byomem-sprint-63-runtime-');
    const projectDir = tempDir('byomem-sprint-63-project-');
    dirs.push(runtimeDir, projectDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    writeGraph(projectDir);

    const cliSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['graph-update', '--base-dir', projectDir, '--json']);
    const cliUpdate = JSON.parse(String(cliSpy.mock.calls.at(-1)?.[0] ?? '{}')) as {
      update?: { nodeCount?: number; edgeCount?: number; source?: string };
      status?: { nodeCount?: number; edgeCount?: number };
    };
    expect(cliUpdate.update).toMatchObject({ source: 'graphify-export', nodeCount: 2, edgeCount: 1 });
    expect(cliUpdate.status).toMatchObject({ nodeCount: 2, edgeCount: 1 });

    cliSpy.mockClear();
    await main(['graph-query', '--base-dir', projectDir, '--query', 'alpha', '--limit', '1', '--json']);
    const cliQuery = JSON.parse(String(cliSpy.mock.calls.at(-1)?.[0] ?? '{}')) as {
      results?: Array<{ node?: { id?: string; label?: string } }>;
    };
    expect(cliQuery.results?.[0]?.node).toMatchObject({ id: 'alpha', label: 'alpha()' });

    const runtimeContext: any = {
      runtimeBaseDir: runtimeDir,
      nativeStore: {},
      status: {},
      embeddingConfig: { source: 'default' },
      fileSearchConfig: { source: 'default' },
      sessionCaptureConfig: { source: 'default', enabled: false },
      summarizerConfig: { source: 'default' },
    };

    const operations = makeMockServer();
    registerOperationsTools(operations.server as never, () => runtimeContext);
    expect(operations.tools.map((tool) => tool.name)).toContain('byomem_graph_update');

    const readonly = makeMockServer();
    registerReadOnlyTools(readonly.server as never, () => runtimeContext);
    expect(readonly.tools.map((tool) => tool.name)).not.toContain('byomem_graph_update');
    expect(readonly.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'byomem_graph_status',
      'byomem_graph_query',
      'byomem_graph_explain',
      'byomem_graph_path',
    ]));

    const mcpQuery = readonly.tools.find((tool) => tool.name === 'byomem_graph_query');
    expect(mcpQuery).toBeDefined();
    const mcpPayload = parseToolPayload(await mcpQuery!.execute({ baseDir: projectDir, query: 'alpha', limit: 1 })) as {
      results?: Array<{ node?: { id?: string; label?: string } }>;
    };
    expect(mcpPayload.results?.[0]?.node).toEqual(cliQuery.results?.[0]?.node);

    const pathTool = readonly.tools.find((tool) => tool.name === 'byomem_graph_path');
    expect(pathTool).toBeDefined();
    const pathPayload = parseToolPayload(await pathTool!.execute({ baseDir: projectDir, source: 'alpha', target: 'beta', maxDepth: 2 })) as {
      found?: boolean;
      path?: Array<{ id?: string }>;
    };
    expect(pathPayload.found).toBe(true);
    expect(pathPayload.path?.map((node) => node.id)).toEqual(['alpha', 'beta']);
  });

  it('does not create graph sqlite files from read-only graph MCP calls on a clean runtime', async () => {
    const runtimeDir = tempDir('byomem-sprint-63-runtime-');
    const projectDir = tempDir('byomem-sprint-63-project-');
    dirs.push(runtimeDir, projectDir);

    const runtimeContext: any = {
      runtimeBaseDir: runtimeDir,
      nativeStore: {},
      status: {},
      embeddingConfig: { source: 'default' },
      fileSearchConfig: { source: 'default' },
      sessionCaptureConfig: { source: 'default', enabled: false },
      summarizerConfig: { source: 'default' },
    };
    const readonly = makeMockServer();
    registerReadOnlyTools(readonly.server as never, () => runtimeContext);

    const statusTool = readonly.tools.find((tool) => tool.name === 'byomem_graph_status');
    expect(statusTool).toBeDefined();
    const statusPayload = parseToolPayload(await statusTool!.execute({ baseDir: projectDir })) as {
      status?: { nodeCount?: number; edgeCount?: number };
    };
    expect(statusPayload.status).toMatchObject({ nodeCount: 0, edgeCount: 0 });
    expect(existsSync(join(runtimeDir, 'byomem-graph.sqlite'))).toBe(false);

    const queryTool = readonly.tools.find((tool) => tool.name === 'byomem_graph_query');
    expect(queryTool).toBeDefined();
    const queryPayload = parseToolPayload(await queryTool!.execute({ baseDir: projectDir, query: 'alpha', limit: 1 })) as {
      results?: unknown[];
    };
    expect(queryPayload.results).toEqual([]);
    expect(existsSync(join(runtimeDir, 'byomem-graph.sqlite'))).toBe(false);
  });
});
