import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createReadOnlyMcpServer } from './readonly-server.js';

export async function main(): Promise<void> {
  const server = createReadOnlyMcpServer();
  await server.connect(new StdioServerTransport());
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
