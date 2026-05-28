import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createReadOnlyMcpServer } from './readonly-server.js';
import { READONLY_MCP_SERVER_NAME } from './readonly-server.js';
import { installRuntimeStateSignalHandlers, registerMcpRuntimeState } from './runtime-state-lifecycle.js';

export async function main(): Promise<void> {
  const lifecycle = registerMcpRuntimeState({ role: 'readonly', serverName: READONLY_MCP_SERVER_NAME, entrypoint: 'mcp-readonly' });
  const uninstallHandlers = installRuntimeStateSignalHandlers(lifecycle);
  try {
    const server = createReadOnlyMcpServer();
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
      command: 'mcp-readonly',
    }));
    process.exitCode = 1;
  });
}
