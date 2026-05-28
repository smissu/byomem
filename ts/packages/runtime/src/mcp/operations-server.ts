import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'node:url';
import { registerReadOnlyTools } from './readonly-tools.js';
import { registerOperationsTools, type OperationsMcpRuntimeContext } from './operations-tools.js';
import { buildOperationsRuntimeContext } from './split-runtime.js';
import { installRuntimeStateSignalHandlers, registerMcpRuntimeState } from './runtime-state-lifecycle.js';
import { BYOMEM_RUNTIME_VERSION } from '../version.js';

export { registerOperationsTools };

export const OPERATIONS_MCP_SERVER_NAME = 'byomem-mcp-operations';
export const OPERATIONS_MCP_SERVER_VERSION = BYOMEM_RUNTIME_VERSION;

type CachedOperationsRuntimeContext = OperationsMcpRuntimeContext;

let runtimeContext: CachedOperationsRuntimeContext | undefined;

function buildRuntimeContext(): CachedOperationsRuntimeContext {
  return buildOperationsRuntimeContext();
}

function getRuntimeContext(): CachedOperationsRuntimeContext {
  runtimeContext ??= buildRuntimeContext();
  return runtimeContext;
}

export function createOperationsMcpServer(): McpServer {
  const server = new McpServer({
    name: OPERATIONS_MCP_SERVER_NAME,
    version: OPERATIONS_MCP_SERVER_VERSION,
  });

  const runtimeInfo = {
    name: OPERATIONS_MCP_SERVER_NAME,
    version: OPERATIONS_MCP_SERVER_VERSION,
    domain: 'operations' as const,
  };
  registerReadOnlyTools(server, getRuntimeContext, { runtimeInfo });
  registerOperationsTools(server, getRuntimeContext, { runtimeInfo });
  return server;
}

export async function main(): Promise<void> {
  console.error(JSON.stringify({
    level: 'warn',
    server: OPERATIONS_MCP_SERVER_NAME,
    message: 'byomem-mcp-operations is a compatibility surface; use split memory, graph, and file-search MCP servers for failure-domain isolation.',
  }));
  const lifecycle = registerMcpRuntimeState({ role: 'operations', serverName: OPERATIONS_MCP_SERVER_NAME, entrypoint: 'mcp-operations' });
  const uninstallHandlers = installRuntimeStateSignalHandlers(lifecycle);
  try {
    const server = createOperationsMcpServer();
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
      command: 'mcp-operations',
    }));
    process.exitCode = 1;
  });
}
