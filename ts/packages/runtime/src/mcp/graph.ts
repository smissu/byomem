#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { GRAPH_MCP_SERVER_NAME, createGraphMcpServer } from './graph-server.js';
import { installRuntimeStateSignalHandlers, registerMcpRuntimeState } from './runtime-state-lifecycle.js';

export { GRAPH_MCP_SERVER_NAME, GRAPH_MCP_SERVER_VERSION, createGraphMcpServer } from './graph-server.js';

export async function main(): Promise<void> {
  const lifecycle = registerMcpRuntimeState({ role: 'graph', serverName: GRAPH_MCP_SERVER_NAME, entrypoint: 'mcp-graph' });
  const uninstallHandlers = installRuntimeStateSignalHandlers(lifecycle);
  try {
    const server = createGraphMcpServer();
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
      command: 'mcp-graph',
    }));
    process.exitCode = 1;
  });
}
