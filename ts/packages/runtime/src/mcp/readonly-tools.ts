import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v3';
import { openGraphDb } from '../graph-db.js';
import { buildByomemRuntimeStatus, safeJson, shapeByomemSearchResults, type ReadOnlyByomemRuntimeContext } from '../readonly-core.js';
import { searchIndex } from '../search-index.js';
import type { MemorySearchMode } from '../sqlite-sidecar.js';
import { BYOMEM_RUNTIME_VERSION } from '../version.js';
import { registerRuntimeInfoTool, type RuntimeInfoServerDescriptor } from './runtime-info.js';

export type ReadOnlyMcpRuntimeContext = ReadOnlyByomemRuntimeContext & {
  status: ReturnType<typeof buildByomemRuntimeStatus>;
};

export type ReadOnlyToolGroup = 'memory' | 'graph';

export const READONLY_MEMORY_TOOL_NAMES = ['status', 'search'] as const;
export const READONLY_GRAPH_TOOL_NAMES = ['byomem_graph_status', 'byomem_graph_query', 'byomem_graph_explain', 'byomem_graph_path'] as const;

function shouldRegisterGroup(groups: ReadonlySet<ReadOnlyToolGroup>, group: ReadOnlyToolGroup): boolean {
  return groups.has(group);
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function normalizeScope(value: unknown): 'project' | 'dir' | 'user' | 'agent' | undefined {
  if (value === 'project' || value === 'dir' || value === 'user' || value === 'agent') return value;
  return undefined;
}

function normalizePositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid ${name}: must be a positive integer`);
  }
  return value;
}

function normalizeSearchMode(value: unknown): MemorySearchMode | undefined {
  if (value === 'bm25' || value === 'semantic' || value === 'hybrid') return value;
  return undefined;
}

const graphQuerySchema = z.object({
  query: z.string().trim().min(1),
  limit: z.number().int().positive().optional(),
  baseDir: z.string().trim().min(1).optional(),
}).strict();
const graphPathSchema = z.object({
  source: z.string().trim().min(1),
  target: z.string().trim().min(1),
  maxDepth: z.number().int().positive().optional(),
  baseDir: z.string().trim().min(1).optional(),
}).strict();
const graphStatusSchema = z.object({
  baseDir: z.string().trim().min(1).optional(),
}).strict();

export function registerReadOnlyTools(
  server: McpServer,
  getRuntimeContext: () => ReadOnlyMcpRuntimeContext,
  options: { groups?: ReadOnlyToolGroup[]; runtimeInfo?: RuntimeInfoServerDescriptor | false } = {},
): void {
  const registerTool = server.registerTool.bind(server) as (...args: any[]) => void;
  const groups = new Set<ReadOnlyToolGroup>(options.groups ?? ['memory', 'graph']);
  if (options.runtimeInfo !== false) {
    registerRuntimeInfoTool(server, options.runtimeInfo ?? { name: 'byomem-mcp-readonly', version: BYOMEM_RUNTIME_VERSION, domain: 'readonly' });
  }

  if (shouldRegisterGroup(groups, 'memory')) {
    registerTool('status', { description: 'Return repo-local BYOMem runtime status for read-only inspection.' }, async () => {
      const runtime = getRuntimeContext();
      return { content: [{ type: 'text', text: safeJson(runtime.status) }] };
    });

    registerTool(
      'search',
      {
        description: 'Search the repo-local BYOMem native store without writing.',
        inputSchema: z.object({
          query: z.string().trim().min(1),
          scope: z.enum(['project', 'dir', 'user', 'agent']).optional(),
          limit: z.number().int().positive().optional(),
          mode: z.enum(['bm25', 'semantic', 'hybrid']).optional(),
        }),
      },
      async (params: { query: string; scope?: 'project' | 'dir' | 'user' | 'agent'; limit?: number; mode?: MemorySearchMode }) => {
        const runtime = getRuntimeContext();
        const query = normalizeText(params.query);
        const scope = normalizeScope(params.scope);
        const limit = normalizePositiveInteger(params.limit, 'limit');
        const mode = normalizeSearchMode(params.mode);
        if (!query) throw new Error('Invalid search intent: query is required');
        const results = shapeByomemSearchResults(
          await searchIndex(runtime.nativeStore, {
            query,
            scope,
            limit,
            mode,
          }),
        );
        return { content: [{ type: 'text', text: safeJson({ results }) }] };
      },
    );
  }

  if (!shouldRegisterGroup(groups, 'graph')) return;

  registerTool(
    'byomem_graph_status',
    {
      description: 'Inspect the native BYOMem graph index without mutating it.',
      inputSchema: graphStatusSchema,
    },
    async (params: unknown) => {
      const runtime = getRuntimeContext();
      const intent = graphStatusSchema.parse(params);
      const graphDb = openGraphDb({ baseDir: intent.baseDir, dbBaseDir: runtime.runtimeBaseDir, readonly: true });
      try {
        const payload = { status: graphDb.status() };
        return { content: [{ type: 'text', text: safeJson(payload) }], details: payload, ...payload };
      } finally {
        graphDb.close();
      }
    },
  );

  registerTool(
    'byomem_graph_query',
    {
      description: 'Query the native BYOMem graph by symbol, label, or source path.',
      inputSchema: graphQuerySchema,
    },
    async (params: unknown) => {
      const runtime = getRuntimeContext();
      const intent = graphQuerySchema.parse(params);
      const graphDb = openGraphDb({ baseDir: intent.baseDir, dbBaseDir: runtime.runtimeBaseDir, readonly: true });
      try {
        const payload = graphDb.query({ query: intent.query, limit: intent.limit });
        return { content: [{ type: 'text', text: safeJson(payload) }], details: payload, ...payload };
      } finally {
        graphDb.close();
      }
    },
  );

  registerTool(
    'byomem_graph_explain',
    {
      description: 'Explain a native BYOMem graph node with incoming and outgoing relationships.',
      inputSchema: graphQuerySchema,
    },
    async (params: unknown) => {
      const runtime = getRuntimeContext();
      const intent = graphQuerySchema.parse(params);
      const graphDb = openGraphDb({ baseDir: intent.baseDir, dbBaseDir: runtime.runtimeBaseDir, readonly: true });
      try {
        const payload = graphDb.explain({ query: intent.query, limit: intent.limit });
        return { content: [{ type: 'text', text: safeJson(payload) }], details: payload, ...payload };
      } finally {
        graphDb.close();
      }
    },
  );

  registerTool(
    'byomem_graph_path',
    {
      description: 'Find a graphify-style relationship path between two native BYOMem graph nodes.',
      inputSchema: graphPathSchema,
    },
    async (params: unknown) => {
      const runtime = getRuntimeContext();
      const intent = graphPathSchema.parse(params);
      const graphDb = openGraphDb({ baseDir: intent.baseDir, dbBaseDir: runtime.runtimeBaseDir, readonly: true });
      try {
        const payload = graphDb.pathQuery({ source: intent.source, target: intent.target, maxDepth: intent.maxDepth });
        return { content: [{ type: 'text', text: safeJson(payload) }], details: payload, ...payload };
      } finally {
        graphDb.close();
      }
    },
  );
}
