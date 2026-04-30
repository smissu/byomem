import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertNoPythonDefaultPath as noPythonDefaultPath } from '../no-python-default-path.js';
import { resolveActiveProjectContext } from '../identity.js';
import { buildByomemRuntimeStatus, openReadOnlyRuntimeContext } from '../readonly-core.js';
import { resolveRuntimeMode } from '../runtime-mode.js';
import { registerReadOnlyTools, type ReadOnlyMcpRuntimeContext } from './readonly-tools.js';

export { registerReadOnlyTools };

export const READONLY_MCP_SERVER_NAME = 'byomem-mcp-readonly';
export const READONLY_MCP_SERVER_VERSION = '0.1.0';

type CachedReadOnlyRuntimeContext = ReadOnlyMcpRuntimeContext;

let runtimeContext: CachedReadOnlyRuntimeContext | undefined;

function buildRuntimeContext(): CachedReadOnlyRuntimeContext {
  const runtime = openReadOnlyRuntimeContext({});
  const activeProject = resolveActiveProjectContext(process.env, process.cwd());
  return {
    ...runtime,
    status: buildByomemRuntimeStatus({
      runtimeMode: resolveRuntimeMode(),
      noPythonDefaultPath: (() => {
        try {
          noPythonDefaultPath('python-default');
          return false;
        } catch {
          return true;
        }
      })(),
      runtimeBaseDir: runtime.runtimeBaseDir,
      nativeStoreBaseDir: runtime.nativeStore.baseDir,
      activeProject,
      embeddingConfig: runtime.embeddingConfig,
      sessionCaptureConfig: runtime.sessionCaptureConfig,
      summarizerConfig: runtime.summarizerConfig,
      fileSearchConfig: runtime.fileSearchConfig,
    }),
  };
}

function getRuntimeContext(): CachedReadOnlyRuntimeContext {
  runtimeContext ??= buildRuntimeContext();
  return runtimeContext;
}

export function createReadOnlyMcpServer(): McpServer {
  const server = new McpServer({
    name: READONLY_MCP_SERVER_NAME,
    version: READONLY_MCP_SERVER_VERSION,
  });

  registerReadOnlyTools(server, getRuntimeContext);
  return server;
}
