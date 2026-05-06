import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v3';
import { buildByomemRuntimeStatus, safeJson, shapeByomemSearchResults, type ReadOnlyByomemRuntimeContext } from '../readonly-core.js';
import { searchIndex } from '../search-index.js';
import type { MemorySearchMode } from '../sqlite-sidecar.js';

export type ReadOnlyMcpRuntimeContext = ReadOnlyByomemRuntimeContext & {
  status: ReturnType<typeof buildByomemRuntimeStatus>;
};

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

export function registerReadOnlyTools(server: McpServer, getRuntimeContext: () => ReadOnlyMcpRuntimeContext): void {
  const registerTool = server.registerTool.bind(server) as (...args: any[]) => void;

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
