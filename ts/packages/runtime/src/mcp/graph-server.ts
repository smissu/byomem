import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildOperationsRuntimeContext } from './split-runtime.js';
import { registerOperationsTools, type OperationsMcpRuntimeContext } from './operations-tools.js';
import { registerReadOnlyTools } from './readonly-tools.js';
import { BYOMEM_RUNTIME_VERSION } from '../version.js';

export const GRAPH_MCP_SERVER_NAME = 'byomem-mcp-graph';
export const GRAPH_MCP_SERVER_VERSION = BYOMEM_RUNTIME_VERSION;

let runtimeContext: OperationsMcpRuntimeContext | undefined;

function getRuntimeContext(): OperationsMcpRuntimeContext {
  runtimeContext ??= buildOperationsRuntimeContext();
  return runtimeContext;
}

export function createGraphMcpServer(): McpServer {
  const server = new McpServer({
    name: GRAPH_MCP_SERVER_NAME,
    version: GRAPH_MCP_SERVER_VERSION,
  });
  const runtimeInfo = {
    name: GRAPH_MCP_SERVER_NAME,
    version: GRAPH_MCP_SERVER_VERSION,
    domain: 'graph' as const,
  };
  registerReadOnlyTools(server, getRuntimeContext, { groups: ['graph'], runtimeInfo });
  registerOperationsTools(server, getRuntimeContext, { groups: ['graph-mutation'], runtimeInfo });
  return server;
}
