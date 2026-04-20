import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { openNativeStore, openReadPath, openWritePath, searchIndex, resolveRuntimeMode, enforceNoPythonDefaultPath } from '../../../ts/packages/runtime/src/index.ts';

const runtimeBaseDir = new URL('../../..//', import.meta.url).pathname;
const embeddingConfig = resolveEmbeddingConfig();
const nativeStore = openNativeStore({
  baseDir: runtimeBaseDir,
  embeddingBaseUrl: embeddingConfig.embeddingBaseUrl,
  embeddingModel: embeddingConfig.embeddingModel,
  embeddingTimeoutMs: embeddingConfig.embeddingTimeoutMs,
  embeddingRequireRemote: Boolean(embeddingConfig.embeddingBaseUrl),
});
const readPath = openReadPath(nativeStore);
const writePath = openWritePath(nativeStore);

export interface ByomemEmbeddingConfig {
  source: 'config' | 'env' | 'default';
  configPath?: string;
  embeddingBaseUrl?: string;
  embeddingModel?: string;
  embeddingTimeoutMs?: number;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
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

function normalizeIdentity(value: unknown): { namespace: string; leafName: string; parentContext?: string; stableKey?: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const identity = value as Record<string, unknown>;
  const namespace = normalizeText(identity.namespace);
  const leafName = normalizeText(identity.leafName);
  if (!namespace || !leafName) return undefined;
  const parentContext = normalizeText(identity.parentContext);
  const stableKey = normalizeText(identity.stableKey);
  return {
    namespace,
    leafName,
    ...(parentContext ? { parentContext } : {}),
    ...(stableKey ? { stableKey } : {}),
  };
}

function normalizeRecordContent(value: unknown): { text?: string; structured?: Record<string, unknown> } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const content = value as Record<string, unknown>;
  const text = normalizeText(content.text);
  const structured = content.structured && typeof content.structured === 'object' && !Array.isArray(content.structured)
    ? (content.structured as Record<string, unknown>)
    : undefined;
  if (!text && !structured) return undefined;
  return {
    ...(text ? { text } : {}),
    ...(structured ? { structured } : {}),
  };
}

function normalizeProvenance(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function normalizeStoreIntent(params: unknown) {
  const intent = params as { scope?: unknown; identity?: unknown; content?: unknown; provenance?: unknown };
  const scope = normalizeScope(intent?.scope);
  const identity = normalizeIdentity(intent?.identity);
  const content = normalizeRecordContent(intent?.content);
  const provenance = normalizeProvenance(intent?.provenance);
  if (!scope || !identity || !content) {
    throw new Error('Invalid byomem_store intent');
  }
  return { scope, identity, content, ...(provenance ? { provenance } : {}) };
}

function normalizePruneIntent(params: unknown) {
  const intent = params as { scope?: unknown; identity?: unknown; id?: unknown };
  const scope = normalizeScope(intent?.scope);
  const identity = normalizeIdentity(intent?.identity);
  const id = normalizeText(intent?.id);
  if (!scope) throw new Error('Invalid byomem_prune intent');
  if (identity) return { scope, identity };
  if (id) {
    const parts = id.split(':');
    if (parts.length >= 4) {
      const [parsedScope, namespace, parentContext, ...leafParts] = parts;
      const leafName = leafParts.join(':');
      if ((parsedScope === scope || !intent.scope) && namespace && parentContext && leafName) {
        return { scope, identity: { namespace, leafName, parentContext, stableKey: id } };
      }
    }
  }
  throw new Error('Invalid byomem_prune intent');
}

function parseConfigYaml(content: string): { embeddings?: { base_url?: string; model?: string; request_timeout?: number } } {
  const embeddingsMatch = content.match(/embeddings:\s*([\s\S]*?)(?:\n\S|$)/);
  if (!embeddingsMatch) return {};
  const block = embeddingsMatch[1] ?? '';
  const baseUrl = block.match(/base_url:\s*(.+)/)?.[1]?.trim();
  const model = block.match(/model:\s*(.+)/)?.[1]?.trim();
  const requestTimeout = block.match(/request_timeout:\s*(\d+)/)?.[1];
  return { embeddings: { base_url: baseUrl, model, request_timeout: requestTimeout ? Number(requestTimeout) : undefined } };
}

function resolveEmbeddingConfig(): ByomemEmbeddingConfig {
  const envBaseUrl = process.env.BYOMEM_EMBEDDING_BASE_URL;
  const envModel = process.env.BYOMEM_EMBEDDING_MODEL;
  const envTimeout = process.env.BYOMEM_EMBEDDING_TIMEOUT_MS;
  if (envBaseUrl || envModel || envTimeout) {
    return {
      source: 'env',
      embeddingBaseUrl: envBaseUrl,
      embeddingModel: envModel,
      embeddingTimeoutMs: envTimeout ? Number(envTimeout) : undefined,
    };
  }

  const configPath = process.env.BYOMEM_CONFIG_PATH ?? resolve(homedir(), '.byomem', 'config.yaml');
  if (existsSync(configPath)) {
    const parsed = parseConfigYaml(readFileSync(configPath, 'utf8'));
    return {
      source: 'config',
      configPath,
      embeddingBaseUrl: parsed.embeddings?.base_url,
      embeddingModel: parsed.embeddings?.model,
      embeddingTimeoutMs: parsed.embeddings?.request_timeout,
    };
  }

  return { source: 'default' };
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
    storeBaseDir: runtimeBaseDir,
    nativeStorePath: nativeStore.path,
    embeddingConfigSource: embeddingConfig.source,
    embeddingConfigPath: embeddingConfig.configPath,
    embeddingBaseUrl: embeddingConfig.embeddingBaseUrl,
    embeddingModel: embeddingConfig.embeddingModel,
    embeddingTimeoutMs: embeddingConfig.embeddingTimeoutMs,
    embeddingRequireRemote: Boolean(embeddingConfig.embeddingBaseUrl),
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
    parameters: { type: 'object', properties: {} },
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
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        scope: { type: 'string', enum: ['project', 'dir', 'user', 'agent'] },
        limit: { type: 'number' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async execute(_toolCallId: string, params: unknown) {
      const intent = params as { query?: unknown; scope?: unknown; limit?: unknown };
      const query = normalizeText(intent?.query);
      const scope = normalizeScope(intent?.scope);
      const limit = typeof intent?.limit === 'number' && Number.isFinite(intent.limit) ? intent.limit : undefined;
      if (!query) throw new Error('Invalid byomem_search intent');
      const results = await Promise.resolve(searchIndex(nativeStore, { query, scope, limit }));
      return { content: [{ type: 'text', text: safeJson({ results }) }], details: { results } };
    },
  });

  pi.registerTool({
    name: 'byomem_store',
    label: 'BYOMem Store',
    description: 'Store a record in the repo-local BYOMem native store.',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['project', 'dir', 'user', 'agent'] },
        identity: {
          type: 'object',
          properties: {
            namespace: { type: 'string' },
            leafName: { type: 'string' },
            parentContext: { type: 'string' },
            stableKey: { type: 'string' },
          },
          required: ['namespace', 'leafName'],
          additionalProperties: false,
        },
        content: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            structured: { type: 'object' },
          },
          additionalProperties: false,
        },
        provenance: {
          type: 'object',
          properties: {},
          additionalProperties: true,
        },
      },
      required: ['scope', 'identity', 'content'],
      additionalProperties: false,
    },
    async execute(_toolCallId: string, params: unknown) {
      const intent = normalizeStoreIntent(params);
      const result = await writePath.write(intent as never);
      return { content: [{ type: 'text', text: safeJson(result) }], details: result };
    },
  });

  pi.registerTool({
    name: 'byomem_prune',
    label: 'BYOMem Prune',
    description: 'Prune a record from the repo-local BYOMem native store.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        scope: { type: 'string', enum: ['project', 'dir', 'user', 'agent'] },
        identity: {
          type: 'object',
          properties: {
            namespace: { type: 'string' },
            leafName: { type: 'string' },
            parentContext: { type: 'string' },
            stableKey: { type: 'string' },
          },
          required: ['namespace', 'leafName'],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId: string, params: unknown) {
      const intent = normalizePruneIntent(params);
      const result = await Promise.resolve(writePath.prune(intent as never));
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
