#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MEMORY_MCP_SERVER_NAME, createMemoryMcpServer } from './memory-server.js';
import { installRuntimeStateSignalHandlers, registerMcpRuntimeState } from './runtime-state-lifecycle.js';

export { MEMORY_MCP_SERVER_NAME, MEMORY_MCP_SERVER_VERSION, createMemoryMcpServer } from './memory-server.js';

export async function main(): Promise<void> {
  const lifecycle = registerMcpRuntimeState({ role: 'memory', serverName: MEMORY_MCP_SERVER_NAME, entrypoint: 'mcp-memory' });
  const uninstallHandlers = installRuntimeStateSignalHandlers(lifecycle);
  try {
    const server = createMemoryMcpServer();
    await server.connect(new StdioServerTransport());
  } catch (error) {
    uninstallHandlers();
    lifecycle.unregister();
    throw error;
  }
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
