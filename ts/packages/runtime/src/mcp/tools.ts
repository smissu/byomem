import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BYOMEM_RUNTIME_VERSION } from '../version.js';
import { registerRuntimeInfoTool } from './runtime-info.js';

export const BOOTSTRAP_MCP_SERVER_NAME = 'byomem-mcp-bootstrap';
export const BOOTSTRAP_MCP_SERVER_VERSION = BYOMEM_RUNTIME_VERSION;

export function registerBootstrapTools(server: McpServer): void {
  registerRuntimeInfoTool(server, {
    name: BOOTSTRAP_MCP_SERVER_NAME,
    version: BOOTSTRAP_MCP_SERVER_VERSION,
    domain: 'bootstrap',
  });

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
