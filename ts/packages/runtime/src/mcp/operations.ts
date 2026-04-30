import { pathToFileURL } from 'node:url';
import {
  OPERATIONS_MCP_SERVER_NAME,
  OPERATIONS_MCP_SERVER_VERSION,
  createOperationsMcpServer,
  main as runOperationsMcpServer,
  registerOperationsTools,
} from './operations-server.js';

export { OPERATIONS_MCP_SERVER_NAME, OPERATIONS_MCP_SERVER_VERSION, createOperationsMcpServer, registerOperationsTools } from './operations-server.js';

const isDirectExecution = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  void runOperationsMcpServer().catch((error: unknown) => {
    console.error(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      command: 'mcp-operations',
    }));
    process.exitCode = 1;
  });
}
