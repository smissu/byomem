#!/usr/bin/env node
import { stdin, stdout } from 'node:process';
import { safeJson } from './readonly-core.js';
import { registerOperationsTools, type OperationsMcpRuntimeContext } from './mcp/operations-tools.js';
import { buildOperationsRuntimeContext } from './mcp/split-runtime.js';
import type { FileSearchWorkerRequest } from './file-search-worker-runner.js';

type RegisteredTool = {
  name: string;
  execute: (params: unknown) => Promise<unknown> | unknown;
};

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stdin.on('error', reject);
    stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function main(): Promise<void> {
  const request = JSON.parse(await readStdin()) as FileSearchWorkerRequest;
  const tools: RegisteredTool[] = [];
  const server = {
    registerTool(name: string, _meta: unknown, execute: (params: unknown) => Promise<unknown> | unknown) {
      tools.push({ name, execute });
    },
  };
  let runtime: OperationsMcpRuntimeContext | undefined;
  registerOperationsTools(server as never, () => {
    runtime ??= buildOperationsRuntimeContext();
    return runtime;
  }, { groups: ['file-search'], fileSearchExecution: 'direct' });
  const tool = tools.find((candidate) => candidate.name === request.toolName);
  if (!tool) throw new Error(`Unsupported file-search worker tool: ${request.toolName}`);
  const result = await tool.execute(request.params);
  stdout.write(`${JSON.stringify(result)}\n`);
}

void main().catch((error: unknown) => {
  stdout.write(`${safeJson({
    content: [{
      type: 'text',
      text: safeJson({
        error: {
          kind: 'worker_failure',
          reason: 'worker-exception',
          retryable: true,
          recoveryHint: 'Retry the file-search operation; inspect worker logs outside MCP if the failure repeats.',
        },
      }),
    }],
  })}\n`);
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error), command: 'file-search-worker' }));
  process.exitCode = 1;
});
