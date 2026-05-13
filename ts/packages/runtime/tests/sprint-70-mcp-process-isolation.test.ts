import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { registerBootstrapTools } from '../src/mcp/tools.js';
import { registerOperationsTools, MCP_TOOL_DOMAIN_MAP } from '../src/mcp/operations-tools.js';
import { registerReadOnlyTools } from '../src/mcp/readonly-tools.js';

type RegisteredTool = {
  name: string;
  execute: (params: Record<string, unknown>) => Promise<unknown> | unknown;
};

function makeMockServer(): { tools: RegisteredTool[]; server: { registerTool: (name: string, meta: unknown, execute: RegisteredTool['execute']) => void } } {
  const tools: RegisteredTool[] = [];
  return {
    tools,
    server: {
      registerTool(name: string, _meta: unknown, execute: RegisteredTool['execute']) {
        tools.push({ name, execute });
      },
    },
  };
}

function toolNames(tools: RegisteredTool[]): string[] {
  return tools.map((tool) => tool.name).sort();
}

function parseFirstContentJson<T>(result: unknown): T {
  const text = (result as { content?: Array<{ text?: string }> }).content?.[0]?.text;
  if (!text) throw new Error('Expected JSON text content');
  return JSON.parse(text) as T;
}

describe('Sprint 70 split MCP tool topology', () => {
  const transports: StdioClientTransport[] = [];

  afterEach(async () => {
    while (transports.length) await transports.pop()!.close();
  });

  it('documents every split tool in an explicit domain map', () => {
    expect(MCP_TOOL_DOMAIN_MAP.memory).toEqual(expect.arrayContaining(['status', 'search', 'store', 'prune']));
    expect(MCP_TOOL_DOMAIN_MAP.graph).toEqual(expect.arrayContaining([
      'byomem_graph_status',
      'byomem_graph_query',
      'byomem_graph_explain',
      'byomem_graph_path',
      'byomem_graph_update',
    ]));
    expect(MCP_TOOL_DOMAIN_MAP.fileSearch).toEqual(expect.arrayContaining([
      'scan',
      'refresh',
      'byomem_file_search',
      'byomem_file_search_find_related',
      'byomem_file_search_project_register',
      'byomem_file_search_project_list',
      'byomem_file_search_project_unregister',
      'byomem_file_search_polling_status',
      'byomem_file_search_polling_enable',
      'byomem_file_search_polling_disable',
    ]));
    expect(MCP_TOOL_DOMAIN_MAP.common).toEqual(expect.arrayContaining(['byomem_runtime_info']));
  });

  it('registers least-privilege memory, graph, and file-search tool groups independently', () => {
    const context = () => ({}) as never;

    const memory = makeMockServer();
    registerReadOnlyTools(memory.server as never, context, { groups: ['memory'] });
    registerOperationsTools(memory.server as never, context, { groups: ['memory-mutation'] });
    expect(toolNames(memory.tools)).toEqual(['byomem_runtime_info', 'prune', 'search', 'status', 'store']);

    const graph = makeMockServer();
    registerReadOnlyTools(graph.server as never, context, { groups: ['graph'] });
    registerOperationsTools(graph.server as never, context, { groups: ['graph-mutation'] });
    expect(toolNames(graph.tools)).toEqual([
      'byomem_graph_explain',
      'byomem_graph_path',
      'byomem_graph_query',
      'byomem_graph_status',
      'byomem_graph_update',
      'byomem_runtime_info',
    ]);

    const fileSearch = makeMockServer();
    registerOperationsTools(fileSearch.server as never, context, { groups: ['file-search'], fileSearchExecution: 'worker' });
    expect(toolNames(fileSearch.tools)).toEqual([...MCP_TOOL_DOMAIN_MAP.common, ...MCP_TOOL_DOMAIN_MAP.fileSearch].sort());
    expect(toolNames(fileSearch.tools)).not.toContain('store');
    expect(toolNames(fileSearch.tools)).not.toContain('byomem_graph_update');
  });

  it('registers runtime info on the bootstrap compatibility server', async () => {
    const bootstrap = makeMockServer();
    registerBootstrapTools(bootstrap.server as never);
    expect(toolNames(bootstrap.tools)).toEqual(['byomem_runtime_info', 'ping', 'version']);
  });

  it('starts split dist MCP servers and exposes only their failure-domain tools', async () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'byomem-s70-split-mcp-runtime-'));
    const cases = [
      {
        name: 'bootstrap',
        path: 'ts/packages/runtime/dist/mcp/bootstrap.js',
        expected: ['ping', 'version', 'byomem_runtime_info'],
        absent: ['store', 'byomem_graph_update', 'byomem_file_search'],
        domain: 'bootstrap',
      },
      {
        name: 'memory',
        path: 'ts/packages/runtime/dist/mcp/memory.js',
        expected: ['status', 'search', 'store', 'prune', 'byomem_runtime_info'],
        absent: ['byomem_graph_update', 'byomem_file_search'],
        domain: 'memory',
      },
      {
        name: 'graph',
        path: 'ts/packages/runtime/dist/mcp/graph.js',
        expected: ['byomem_graph_status', 'byomem_graph_query', 'byomem_graph_explain', 'byomem_graph_path', 'byomem_graph_update', 'byomem_runtime_info'],
        absent: ['store', 'byomem_file_search'],
        domain: 'graph',
      },
      {
        name: 'file-search',
        path: 'ts/packages/runtime/dist/mcp/file-search.js',
        expected: [...MCP_TOOL_DOMAIN_MAP.common, ...MCP_TOOL_DOMAIN_MAP.fileSearch],
        absent: ['store', 'byomem_graph_update', 'search'],
        domain: 'file-search',
      },
    ];

    for (const item of cases) {
      const transport = new StdioClientTransport({
        command: 'node',
        args: [join(process.cwd(), item.path)],
        cwd: process.cwd(),
        env: { ...process.env, BYOMEM_RUNTIME_BASE_DIR: runtimeDir },
      });
      transports.push(transport);
      const client = new Client({ name: `sprint-70-${item.name}`, version: '1.0.0' });
      await client.connect(transport);
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(item.expected));
      for (const absent of item.absent) expect(names).not.toContain(absent);
      const runtimeInfo = parseFirstContentJson<{
        runtime: { name: string; packageVersion: string; protocolVersion: number; features: string[] };
        server: { name: string; version: string; domain: string };
        build: { sourceRoot: string };
      }>(await client.callTool({ name: 'byomem_runtime_info', arguments: {} }));
      expect(runtimeInfo.runtime).toMatchObject({
        name: 'byomem',
        protocolVersion: 1,
      });
      expect(runtimeInfo.runtime.packageVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(runtimeInfo.runtime.features).toEqual(expect.arrayContaining([
        'split-mcp-servers',
        'file-search-worker',
        'native-source-graph',
        'file-search-include-graph',
        'byomem-runtime-info',
      ]));
      expect(runtimeInfo.server.domain).toBe(item.domain);
      expect(runtimeInfo.server.name).toContain('byomem-mcp');
      expect(runtimeInfo.server.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(runtimeInfo.build.sourceRoot).toContain('ts/packages/runtime');
      await client.close();
    }
  });
});
