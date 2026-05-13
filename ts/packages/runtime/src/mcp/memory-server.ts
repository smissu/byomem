import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildOperationsRuntimeContext } from './split-runtime.js';
import { registerOperationsTools, type OperationsMcpRuntimeContext } from './operations-tools.js';
import { registerReadOnlyTools } from './readonly-tools.js';

export const MEMORY_MCP_SERVER_NAME = 'byomem-mcp-memory';
export const MEMORY_MCP_SERVER_VERSION = '0.1.0';

let runtimeContext: OperationsMcpRuntimeContext | undefined;

function getRuntimeContext(): OperationsMcpRuntimeContext {
  runtimeContext ??= buildOperationsRuntimeContext();
  return runtimeContext;
}

export function createMemoryMcpServer(): McpServer {
  const server = new McpServer({
    name: MEMORY_MCP_SERVER_NAME,
    version: MEMORY_MCP_SERVER_VERSION,
  });
  const runtimeInfo = {
    name: MEMORY_MCP_SERVER_NAME,
    version: MEMORY_MCP_SERVER_VERSION,
    domain: 'memory' as const,
  };
  registerReadOnlyTools(server, getRuntimeContext, { groups: ['memory'], runtimeInfo });
  registerOperationsTools(server, getRuntimeContext, { groups: ['memory-mutation'], runtimeInfo });
  return server;
}
