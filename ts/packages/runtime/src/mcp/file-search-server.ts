import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildOperationsRuntimeContext } from './split-runtime.js';
import { registerOperationsTools, type OperationsMcpRuntimeContext } from './operations-tools.js';

export const FILE_SEARCH_MCP_SERVER_NAME = 'byomem-mcp-file-search';
export const FILE_SEARCH_MCP_SERVER_VERSION = '0.1.0';

let runtimeContext: OperationsMcpRuntimeContext | undefined;

function getRuntimeContext(): OperationsMcpRuntimeContext {
  runtimeContext ??= buildOperationsRuntimeContext();
  return runtimeContext;
}

export function createFileSearchMcpServer(): McpServer {
  const server = new McpServer({
    name: FILE_SEARCH_MCP_SERVER_NAME,
    version: FILE_SEARCH_MCP_SERVER_VERSION,
  });
  registerOperationsTools(server, getRuntimeContext, {
    groups: ['file-search'],
    fileSearchExecution: 'worker',
    runtimeInfo: {
      name: FILE_SEARCH_MCP_SERVER_NAME,
      version: FILE_SEARCH_MCP_SERVER_VERSION,
      domain: 'file-search',
    },
  });
  return server;
}
