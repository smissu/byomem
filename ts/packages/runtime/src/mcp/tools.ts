import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export const BOOTSTRAP_MCP_SERVER_NAME = 'byomem-mcp-bootstrap';
export const BOOTSTRAP_MCP_SERVER_VERSION = '0.1.0';

export function registerBootstrapTools(server: McpServer): void {
  server.registerTool('ping', {
    description: 'Return a trivial acknowledgement for transport verification.',
  }, async () => ({
    content: [{ type: 'text', text: 'pong' }],
  }));

  server.registerTool('version', {
    description: 'Return the bootstrap server name and version.',
  }, async () => ({
    content: [{ type: 'text', text: `${BOOTSTRAP_MCP_SERVER_NAME} ${BOOTSTRAP_MCP_SERVER_VERSION}` }],
  }));
}
