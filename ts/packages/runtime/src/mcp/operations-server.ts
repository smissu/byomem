import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'node:url';
import { assertNoPythonDefaultPath as noPythonDefaultPath } from '../no-python-default-path.js';
import { resolveActiveProjectContext } from '../identity.js';
import { buildByomemRuntimeStatus, openReadOnlyRuntimeContext } from '../readonly-core.js';
import { resolveRuntimeMode } from '../runtime-mode.js';
import { openNativeStore } from '../store.js';
import { registerReadOnlyTools } from './readonly-tools.js';
import { registerOperationsTools, type OperationsMcpRuntimeContext } from './operations-tools.js';

export { registerOperationsTools };

export const OPERATIONS_MCP_SERVER_NAME = 'byomem-mcp-operations';
export const OPERATIONS_MCP_SERVER_VERSION = '0.1.0';

type CachedOperationsRuntimeContext = OperationsMcpRuntimeContext;

let runtimeContext: CachedOperationsRuntimeContext | undefined;

function buildRuntimeContext(): CachedOperationsRuntimeContext {
  const runtime = openReadOnlyRuntimeContext({});
  const activeProject = resolveActiveProjectContext(process.env, process.cwd());
  const nativeStore = openNativeStore({
    baseDir: runtime.runtimeBaseDir,
    embeddingBaseUrl: runtime.embeddingConfig.embeddingBaseUrl,
    embeddingModel: runtime.embeddingConfig.embeddingModel,
    embeddingDimension: runtime.embeddingConfig.embeddingDimension,
    embeddingTimeoutMs: runtime.embeddingConfig.embeddingTimeoutMs,
    embeddingRequireRemote: Boolean(runtime.embeddingConfig.embeddingBaseUrl),
    fileSearchSemanticEnabled: true,
    fileSearchScanOnOpen: false,
    fileSearchSchedulerEnabled: false,
    fileSearchScannerExcludedExtensions: runtime.fileSearchConfig.excludedExtensions,
    fileSearchBinaryDetectionEnabled: runtime.fileSearchConfig.binaryDetectionEnabled,
  });
  const noPythonDisabled = (() => {
    try {
      noPythonDefaultPath('python-default');
      return false;
    } catch {
      return true;
    }
  })();

  return {
    ...runtime,
    nativeStore,
    status: buildByomemRuntimeStatus({
      runtimeMode: resolveRuntimeMode(),
      noPythonDefaultPath: noPythonDisabled,
      runtimeBaseDir: runtime.runtimeBaseDir,
      nativeStoreBaseDir: nativeStore.baseDir,
      activeProject,
      embeddingConfig: runtime.embeddingConfig,
      sessionCaptureConfig: runtime.sessionCaptureConfig,
      summarizerConfig: runtime.summarizerConfig,
      fileSearchConfig: runtime.fileSearchConfig,
    }),
  };
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

  registerReadOnlyTools(server, getRuntimeContext);
  registerOperationsTools(server, getRuntimeContext);
  return server;
}

export async function main(): Promise<void> {
  const server = createOperationsMcpServer();
  await server.connect(new StdioServerTransport());
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
