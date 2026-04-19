import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { openReadPath, openWritePath, openSharedCorpusStore, searchIndex, resolveRuntimeMode, enforceNoPythonDefaultPath, resolveCorpusPath } from '../../../ts/packages/runtime/src/index.ts';

const runtimeBaseDir = new URL('../../..//', import.meta.url).pathname;
const sharedCorpusDir = resolveCorpusPath({ baseDir: runtimeBaseDir });
const store = openSharedCorpusStore({ baseDir: runtimeBaseDir });
const readPath = openReadPath(store);
const writePath = openWritePath(store);

function safeJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function byomem_runtime_status() {
  const mode = resolveRuntimeMode();
  return {
    runtimeMode: mode,
    pythonDefaultDisabled: true,
    noPythonDefaultPath: (() => {
      try {
        enforceNoPythonDefaultPath('python-default');
        return false;
      } catch {
        return true;
      }
    })(),
    packageSurface: 'ts/packages/runtime',
    storeBaseDir: sharedCorpusDir,
    sharedCorpusPath: store.path,
  };
}

export default function (pi: ExtensionAPI) {
  pi.on('session_start', async (_event, ctx) => {
    ctx.ui.notify('BYOMem TS runtime loaded', 'info');
  });

  pi.registerTool({
    name: 'byomem_runtime_status',
    label: 'BYOMem Runtime Status',
    description: 'Return the repo-local TS runtime status for BYOMem validation.',
    parameters: undefined,
    async execute(_toolCallId: string, _params: unknown) {
      const status = byomem_runtime_status();
      return {
        content: [{ type: 'text', text: safeJson(status) }],
        details: status,
      };
    },
  });

  pi.registerTool({
    name: 'byomem_search',
    label: 'BYOMem Search',
    description: 'Search the repo-local BYOMem native store.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, scope: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
    async execute(_toolCallId: string, params: unknown) {
      const { query, scope, limit } = (params ?? {}) as { query?: string; scope?: 'project' | 'dir' | 'user' | 'agent'; limit?: number };
      const results = searchIndex(store, { query: query ?? '', scope, limit });
      return { content: [{ type: 'text', text: safeJson({ results }) }], details: { results } };
    },
  });

  pi.registerTool({
    name: 'byomem_store',
    label: 'BYOMem Store',
    description: 'Store a record in the repo-local BYOMem native store.',
    parameters: { type: 'object', properties: { scope: { type: 'string' }, identity: { type: 'object' }, content: { type: 'object' }, provenance: { type: 'object' } }, required: ['scope', 'identity', 'content'] },
    async execute(_toolCallId: string, params: unknown) {
      const result = writePath.write(params as never);
      return { content: [{ type: 'text', text: safeJson(result) }], details: result };
    },
  });

  pi.registerTool({
    name: 'byomem_prune',
    label: 'BYOMem Prune',
    description: 'Prune a record from the repo-local BYOMem native store.',
    parameters: { type: 'object', properties: { scope: { type: 'string' }, identity: { type: 'object' } }, required: ['scope', 'identity'] },
    async execute(_toolCallId: string, params: unknown) {
      const result = writePath.prune(params as never);
      return { content: [{ type: 'text', text: safeJson(result) }], details: result };
    },
  });

  pi.registerCommand('byomem-status', {
    description: 'Show repo-local BYOMem TS runtime status',
    handler: async (_args: string, ctx) => {
      ctx.ui.notify(JSON.stringify(byomem_runtime_status(), null, 2), 'info');
    },
  });
}
