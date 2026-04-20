import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { openNativeStore, openReadPath, openWritePath, searchIndex, resolveRuntimeMode, enforceNoPythonDefaultPath, captureSessionCheckpoint, type SessionCaptureInput } from '../../../ts/packages/runtime/src/index.ts';

const runtimeBaseDir = process.env.BYOMEM_RUNTIME_BASE_DIR ?? new URL('../../..//', import.meta.url).pathname;
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

function resolveSessionManagerDetails(sessionManager: unknown) {
  const details = sessionManager as { getSessionId?: () => unknown; getSessionFile?: () => unknown; getEntries?: () => unknown } | undefined;
  const sessionId = typeof details?.getSessionId === 'function' ? details.getSessionId() : undefined;
  const sessionFile = typeof details?.getSessionFile === 'function' ? details.getSessionFile() : undefined;
  const entries = typeof details?.getEntries === 'function' ? details.getEntries() : undefined;
  return {
    sessionId: typeof sessionId === 'string' ? sessionId : undefined,
    sessionFile: typeof sessionFile === 'string'
      ? sessionFile
      : sessionFile && typeof sessionFile === 'object' && 'path' in (sessionFile as Record<string, unknown>) && typeof (sessionFile as Record<string, unknown>).path === 'string'
        ? (sessionFile as Record<string, unknown>).path as string
        : undefined,
    entryCount: Array.isArray(entries) ? entries.length : undefined,
  };
}

type TurnEndEvent = { type?: unknown; message?: unknown; toolResults?: unknown; messages?: unknown[]; sessionId?: unknown; transcriptPath?: unknown };

function resolveSessionCaptureInput(ctx: Record<string, unknown>, eventName: string, event: TurnEndEvent): SessionCaptureInput | null {
  const sessionManagerDetails = resolveSessionManagerDetails(ctx.sessionManager);
  const sessionId = sessionManagerDetails.sessionId
    ?? (typeof ctx.session_id === 'string' ? ctx.session_id : undefined)
    ?? (typeof ctx.sessionId === 'string' ? ctx.sessionId : undefined)
    ?? (typeof event.sessionId === 'string' ? event.sessionId : undefined);
  const transcriptPath = sessionManagerDetails.sessionFile
    ?? (typeof ctx.transcript_path === 'string' ? ctx.transcript_path : undefined)
    ?? (typeof ctx.transcriptPath === 'string' ? ctx.transcriptPath : undefined)
    ?? (typeof event.transcriptPath === 'string' ? event.transcriptPath : undefined);
  if (!sessionId || !transcriptPath) return null;
  const messageCount = typeof ctx.message_count === 'number'
    ? ctx.message_count
    : typeof ctx.messageCount === 'number'
      ? ctx.messageCount
      : Array.isArray(event.messages)
        ? event.messages.length
        : sessionManagerDetails.entryCount;
  const transcriptBytes = typeof ctx.transcript_bytes === 'number'
    ? ctx.transcript_bytes
    : typeof ctx.transcriptBytes === 'number'
      ? ctx.transcriptBytes
      : undefined;
  const agent = typeof ctx.agent_name === 'string'
    ? ctx.agent_name
    : typeof ctx.name === 'string'
      ? ctx.name
      : typeof (ctx.agent as { name?: string } | undefined)?.name === 'string'
        ? (ctx.agent as { name?: string }).name
        : undefined;
  const model = typeof ctx.model === 'string'
    ? ctx.model
    : typeof ctx.model_name === 'string'
      ? ctx.model_name
      : undefined;
  return {
    sessionId,
    transcriptPath,
    event: eventName,
    final: typeof ctx.final === 'boolean' ? ctx.final : eventName === 'session_shutdown',
    idle: typeof ctx.idle === 'boolean' ? ctx.idle : false,
    agent,
    model,
    messageCount,
    transcriptBytes,
  };
}

async function captureSessionFromHook(eventName: string, ctx: Record<string, unknown>, event: TurnEndEvent): Promise<void> {
  const input = resolveSessionCaptureInput(ctx, eventName, event);
  if (!input) return;
  try {
    await captureSessionCheckpoint(nativeStore, { baseDir: runtimeBaseDir }, input);
  } catch {
    return;
  }
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
    ctx.ui?.notify?.('BYOMem TS runtime loaded', 'info');
  });
  pi.on('turn_end', async (event, ctx) => {
    await captureSessionFromHook('turn_end', ctx as Record<string, unknown>, event as TurnEndEvent);
  });
  pi.on('session_before_switch', async (event, ctx) => {
    await captureSessionFromHook('session_before_switch', ctx as Record<string, unknown>, event as TurnEndEvent);
  });
  pi.on('session_shutdown', async (event, ctx) => {
    await captureSessionFromHook('session_shutdown', ctx as Record<string, unknown>, event as TurnEndEvent);
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
