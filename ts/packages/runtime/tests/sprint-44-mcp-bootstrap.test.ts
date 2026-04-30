import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

describe('sprint 44 MCP bootstrap', () => {
  const transports: StdioClientTransport[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (transports.length) {
      await transports.pop()!.close();
    }
  });

  it('speaks real MCP over stdio and exposes trivial tools', async () => {
    const bootstrapPath = join(process.cwd(), 'ts/packages/runtime/dist/mcp/bootstrap.js');
    const transport = new StdioClientTransport({
      command: 'node',
      args: [bootstrapPath],
      cwd: process.cwd(),
    });
    transports.push(transport);

    const client = new Client({ name: 'sprint-44-bootstrap-test', version: '1.0.0' });
    await client.connect(transport);

    const toolList = await client.listTools();
    expect(toolList.tools.map((tool) => tool.name)).toEqual(['ping', 'version']);

    const pingResult = await client.callTool({ name: 'ping' });
    expect(pingResult.content).toEqual([
      expect.objectContaining({
        type: 'text',
        text: 'pong',
      }),
    ]);

    const versionResult = await client.callTool({ name: 'version' });
    expect(versionResult.content).toEqual([
      expect.objectContaining({
        type: 'text',
        text: expect.stringMatching(/byomem/i),
      }),
    ]);

    await client.close();
  });
});
