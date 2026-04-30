import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function makeTempRuntime(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-readonly-mcp-'));
}

describe('Sprint 45 read-only MCP server', () => {
  const transports: StdioClientTransport[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (transports.length) {
      await transports.pop()!.close();
    }
  });

  it('speaks real MCP over stdio and keeps tool calls read-only', async () => {
    const runtimeDir = makeTempRuntime();
    const snapshotPath = join(runtimeDir, 'native-store.json');
    const seed = {
      version: 1,
      records: [
        {
          id: 'project:notes:root:read-only-search-target',
          scope: 'project',
          provenance: { source: 'fixture' },
          identity: {
            namespace: 'notes',
            leafName: 'read-only-search-target',
            parentContext: 'root',
          },
          content: {
            text: 'Read-only MCP search target for Sprint 45',
          },
          metadata: {
            createdAt: '2026-04-30T00:00:00.000Z',
            updatedAt: '2026-04-30T00:00:00.000Z',
          },
        },
      ],
    };
    writeFileSync(snapshotPath, `${JSON.stringify(seed, null, 2)}\n`, 'utf8');
    const before = readFileSync(snapshotPath, 'utf8');

    const readonlyPath = join(process.cwd(), 'ts/packages/runtime/dist/mcp/readonly.js');
    const transport = new StdioClientTransport({
      command: 'node',
      args: [readonlyPath],
      cwd: process.cwd(),
      env: {
        ...process.env,
        BYOMEM_RUNTIME_BASE_DIR: runtimeDir,
      },
    });
    transports.push(transport);

    const client = new Client({ name: 'sprint-45-readonly-mcp-test', version: '1.0.0' });
    await client.connect(transport);

    const toolList = await client.listTools();
    expect(toolList.tools.map((tool) => tool.name)).toEqual(['status', 'search']);

    const statusResult = await client.callTool({ name: 'status' });
    const status = JSON.parse(statusResult.content[0].text ?? '{}') as Record<string, unknown>;
    expect(status).toMatchObject({
      packageSurface: 'ts/packages/runtime',
      runtimeMode: expect.any(String),
      storeBaseDir: runtimeDir,
      nativeStorePath: runtimeDir,
      activeProject: expect.any(Object),
    });

    const searchResult = await client.callTool({ name: 'search', arguments: { query: 'search target', limit: 5 } });
    const payload = JSON.parse(searchResult.content[0].text ?? '{}') as { results?: Array<Record<string, unknown>> };
    expect(payload.results?.[0]).toMatchObject({
      id: 'project:notes:root:read-only-search-target',
      scope: 'project',
      text: 'Read-only MCP search target for Sprint 45',
      provenance: { source: 'fixture' },
    });

    await client.close();

    expect(readFileSync(snapshotPath, 'utf8')).toBe(before);
    expect(existsSync(join(runtimeDir, 'byomem-index.sqlite'))).toBe(false);
  });
});
