import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBootstrapMcpServer } from './server.js';
import { BOOTSTRAP_MCP_SERVER_NAME } from './server.js';
import { installRuntimeStateSignalHandlers, registerMcpRuntimeState } from './runtime-state-lifecycle.js';

export async function main(): Promise<void> {
  const lifecycle = registerMcpRuntimeState({ role: 'bootstrap', serverName: BOOTSTRAP_MCP_SERVER_NAME, entrypoint: 'mcp-bootstrap' });
  const uninstallHandlers = installRuntimeStateSignalHandlers(lifecycle);
  try {
    const server = createBootstrapMcpServer();
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
      command: 'mcp-bootstrap',
    }));
    process.exitCode = 1;
  });
}
