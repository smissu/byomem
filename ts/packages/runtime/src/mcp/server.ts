import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BOOTSTRAP_MCP_SERVER_NAME, BOOTSTRAP_MCP_SERVER_VERSION, registerBootstrapTools } from './tools.js';

export { BOOTSTRAP_MCP_SERVER_NAME, BOOTSTRAP_MCP_SERVER_VERSION, registerBootstrapTools };

export function createBootstrapMcpServer(): McpServer {
  const server = new McpServer({
    name: BOOTSTRAP_MCP_SERVER_NAME,
    version: BOOTSTRAP_MCP_SERVER_VERSION,
  });

  registerBootstrapTools(server);
  return server;
}
