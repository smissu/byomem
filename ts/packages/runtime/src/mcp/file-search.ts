#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { FILE_SEARCH_MCP_SERVER_NAME, createFileSearchMcpServer } from './file-search-server.js';
import { installRuntimeStateSignalHandlers, registerMcpRuntimeState } from './runtime-state-lifecycle.js';

export { FILE_SEARCH_MCP_SERVER_NAME, FILE_SEARCH_MCP_SERVER_VERSION, createFileSearchMcpServer } from './file-search-server.js';

export async function main(): Promise<void> {
  const lifecycle = registerMcpRuntimeState({ role: 'file-search', serverName: FILE_SEARCH_MCP_SERVER_NAME, entrypoint: 'mcp-file-search' });
  const uninstallHandlers = installRuntimeStateSignalHandlers(lifecycle);
  try {
    const server = createFileSearchMcpServer();
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
      command: 'mcp-file-search',
    }));
    process.exitCode = 1;
  });
}
