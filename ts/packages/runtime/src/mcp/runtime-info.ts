import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { safeJson } from '../readonly-core.js';

const require = createRequire(import.meta.url);

export const BYOMEM_RUNTIME_INFO_TOOL_NAME = 'byomem_runtime_info';
export const BYOMEM_RUNTIME_PROTOCOL_VERSION = 1;
export const BYOMEM_RUNTIME_FEATURES = [
  'split-mcp-servers',
  'file-search-worker',
  'native-source-graph',
  'file-search-include-graph',
  'byomem-runtime-info',
] as const;

export type RuntimeInfoServerDescriptor = {
  name: string;
  version: string;
  domain: 'bootstrap' | 'readonly' | 'operations' | 'memory' | 'graph' | 'file-search';
};

export type ByomemRuntimeInfo = {
  runtime: {
    name: 'byomem';
    packageVersion: string;
    protocolVersion: number;
    features: string[];
  };
  server: RuntimeInfoServerDescriptor;
  build: {
    sourceRoot: string;
    moduleUrl: string;
  };
};

const registeredServers = new WeakSet<object>();

function readPackageVersion(fallback: string): string {
  for (const packagePath of ['../../package.json', '../../../../../package.json']) {
    try {
      const packageJson = require(packagePath) as { version?: unknown };
      if (typeof packageJson.version === 'string' && packageJson.version.trim()) return packageJson.version;
    } catch {
      // Try the next package metadata location.
    }
  }
  return fallback;
}

function resolveSourceRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function buildByomemRuntimeInfo(server: RuntimeInfoServerDescriptor): ByomemRuntimeInfo {
  return {
    runtime: {
      name: 'byomem',
      packageVersion: readPackageVersion(server.version),
      protocolVersion: BYOMEM_RUNTIME_PROTOCOL_VERSION,
      features: [...BYOMEM_RUNTIME_FEATURES],
    },
    server,
    build: {
      sourceRoot: resolveSourceRoot(),
      moduleUrl: import.meta.url,
    },
  };
}

export function registerRuntimeInfoTool(server: McpServer, descriptor: RuntimeInfoServerDescriptor): void {
  if (registeredServers.has(server as object)) return;
  registeredServers.add(server as object);
  server.registerTool(
    BYOMEM_RUNTIME_INFO_TOOL_NAME,
    {
      description: 'Return structured BYOMem runtime, build, and feature information for harness verification.',
    },
    async () => {
      const payload = buildByomemRuntimeInfo(descriptor);
      return {
        content: [{ type: 'text', text: safeJson(payload) }],
        details: payload,
        ...payload,
      };
    },
  );
}
