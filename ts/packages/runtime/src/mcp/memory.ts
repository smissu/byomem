#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMemoryMcpServer } from './memory-server.js';

export { MEMORY_MCP_SERVER_NAME, MEMORY_MCP_SERVER_VERSION, createMemoryMcpServer } from './memory-server.js';

export async function main(): Promise<void> {
  const server = createMemoryMcpServer();
  await server.connect(new StdioServerTransport());
}

const isDirectExecution = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  void main().catch((error: unknown) => {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      command: 'mcp-memory',
    }));
    process.exitCode = 1;
  });
}
