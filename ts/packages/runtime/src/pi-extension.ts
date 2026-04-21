import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { openNativeStore, openReadPath, openWritePath, searchIndex, resolveRuntimeMode, enforceNoPythonDefaultPath, captureSessionCheckpoint, type SessionCaptureInput } from './index.ts';

function resolveDefaultRuntimeBaseDir(): string {
  let currentDir = resolve(process.cwd());
  while (true) {
    if (existsSync(join(currentDir, '.git'))) return currentDir;
    const parentDir = resolve(currentDir, '..');
    if (parentDir === currentDir) return currentDir;
    currentDir = parentDir;
  }
}

const runtimeBaseDir = process.env.BYOMEM_RUNTIME_BASE_DIR ?? resolveDefaultRuntimeBaseDir();
const embeddingConfig = resolveEmbeddingConfig();
const sessionCaptureConfig = resolveSessionCaptureConfig();
const summarizerConfig = resolveSummarizerConfig();
const nativeStore = openNativeStore({
  baseDir: runtimeBaseDir,
  embeddingBaseUrl: embeddingConfig.embeddingBaseUrl,
  embeddingModel: embeddingConfig.embeddingModel,
  embeddingTimeoutMs: embeddingConfig.embeddingTimeoutMs,
  embeddingRequireRemote: Boolean(embeddingConfig.embeddingBaseUrl),
});
const readPath = openReadPath(nativeStore);
const writePath = openWritePath(nativeStore);
const debugLogPath = join(runtimeBaseDir, 'queue', 'debug', 'byomem-turn-end.jsonl');
let shouldInjectInitialContext = true;

function logTurnEndDebug(entry: Record<string, unknown>): void {
  try {
    mkdirSync(join(runtimeBaseDir, 'queue', 'debug'), { recursive: true });
    appendFileSync(debugLogPath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, 'utf8');
  } catch {
    // best-effort diagnostics only
  }
}


export interface ByomemSummarizerConfig {
  source: 'config' | 'env' | 'default';
  configPath?: string;
  generationBaseUrl?: string;
  generationModel?: string;
  generationFallbackModel?: string;
  generationTimeoutMs?: number;
  generationTransport?: 'openai-chat-completions' | 'ollama-native-chat';
  ollamaNumCtx?: number;
}

export interface ByomemSessionCaptureConfig {
  source: 'config' | 'default';
  configPath?: string;
  enabled: boolean;
  thresholdTurns?: number;
  largeTurnChars?: number;
  idleFlushSeconds?: number;
  minTurns?: number;
}

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

function extractYamlBlock(content: string, key: string): string | undefined {
  const match = content.match(new RegExp(`${key}:\\s*([\\s\\S]*?)(?:\\n\\S|$)`));
  return match?.[1] ?? undefined;
}

function parseConfigYaml(content: string): { embeddings?: { base_url?: string; model?: string; request_timeout?: number }; summarizer?: { base_url?: string; model?: string; fallback_model?: string; max_tokens?: number; ollama_num_ctx?: number }; session_capture?: { enabled?: boolean; threshold_turns?: number; large_turn_chars?: number; idle_flush_seconds?: number; min_turns?: number } } {
  const embeddingsBlock = extractYamlBlock(content, 'embeddings') ?? '';
  const summarizerBlock = extractYamlBlock(content, 'summarizer') ?? '';
  const sessionCaptureBlock = extractYamlBlock(content, 'session_capture') ?? '';
  const parseBool = (value: string | undefined) => value?.trim() === 'true' ? true : value?.trim() === 'false' ? false : undefined;
  return {
    embeddings: {
      base_url: embeddingsBlock.match(/base_url:\s*(.+)/)?.[1]?.trim(),
      model: embeddingsBlock.match(/model:\s*(.+)/)?.[1]?.trim(),
      request_timeout: (() => { const value = embeddingsBlock.match(/request_timeout:\s*(\d+)/)?.[1]; return value ? Number(value) : undefined; })(),
    },
    summarizer: {
      base_url: summarizerBlock.match(/base_url:\s*(.+)/)?.[1]?.trim(),
      model: summarizerBlock.match(/model:\s*(.+)/)?.[1]?.trim(),
      fallback_model: summarizerBlock.match(/fallback_model:\s*(.+)/)?.[1]?.trim(),
      max_tokens: (() => { const value = summarizerBlock.match(/max_tokens:\s*(\d+)/)?.[1]; return value ? Number(value) : undefined; })(),
      ollama_num_ctx: (() => { const value = summarizerBlock.match(/ollama_num_ctx:\s*(\d+)/)?.[1]; return value ? Number(value) : undefined; })(),
    },
    session_capture: {
      enabled: parseBool(sessionCaptureBlock.match(/enabled:\s*(.+)/)?.[1]),
      threshold_turns: (() => { const value = sessionCaptureBlock.match(/threshold_turns:\s*(\d+)/)?.[1]; return value ? Number(value) : undefined; })(),
      large_turn_chars: (() => { const value = sessionCaptureBlock.match(/large_turn_chars:\s*(\d+)/)?.[1]; return value ? Number(value) : undefined; })(),
      idle_flush_seconds: (() => { const value = sessionCaptureBlock.match(/idle_flush_seconds:\s*(\d+)/)?.[1]; return value ? Number(value) : undefined; })(),
      min_turns: (() => { const value = sessionCaptureBlock.match(/min_turns:\s*(\d+)/)?.[1]; return value ? Number(value) : undefined; })(),
    },
  };
}


function resolveConfigPath(): string {
  return process.env.BYOMEM_CONFIG_PATH ?? resolve(homedir(), '.byomem', 'config.yaml');
}

function inferSummarizerTransport(baseUrl: string | undefined): ByomemSummarizerConfig['generationTransport'] {
  if (!baseUrl) return undefined;
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') return undefined;
    if (parsed.port && parsed.port !== '11434') return undefined;
    if (parsed.pathname === '/' || parsed.pathname === '/v1' || parsed.pathname.startsWith('/v1/')) return 'ollama-native-chat';
  } catch {
    return undefined;
  }
  return undefined;
}

function resolveSummarizerConfig(): ByomemSummarizerConfig {
  const configPath = resolveConfigPath();
  if (existsSync(configPath)) {
    const parsed = parseConfigYaml(readFileSync(configPath, 'utf8'));
    return {
      source: 'config',
      configPath,
      generationBaseUrl: parsed.summarizer?.base_url,
      generationModel: parsed.summarizer?.model,
      generationFallbackModel: parsed.summarizer?.fallback_model,
      generationTimeoutMs: undefined,
      generationTransport: inferSummarizerTransport(parsed.summarizer?.base_url),
      ollamaNumCtx: parsed.summarizer?.ollama_num_ctx,
    };
  }
  return { source: 'default' };
}

function resolveSessionCaptureConfig(): ByomemSessionCaptureConfig {
  const configPath = resolveConfigPath();
  if (existsSync(configPath)) {
    const parsed = parseConfigYaml(readFileSync(configPath, 'utf8'));
    return {
      source: 'config',
      configPath,
      enabled: parsed.session_capture?.enabled ?? true,
      thresholdTurns: parsed.session_capture?.threshold_turns,
      largeTurnChars: parsed.session_capture?.large_turn_chars,
      idleFlushSeconds: parsed.session_capture?.idle_flush_seconds,
      minTurns: parsed.session_capture?.min_turns,
    };
  }
  return { source: 'default', enabled: true };
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

  const configPath = resolveConfigPath();
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
  logTurnEndDebug({ hook: eventName, phase: 'entered' });
  const input = resolveSessionCaptureInput(ctx, eventName, event);
  logTurnEndDebug({
    hook: eventName,
    phase: 'session_capture_input_resolved',
    resolved: Boolean(input),
    sessionId: input?.sessionId,
    transcriptPath: input?.transcriptPath,
  });
  if (!input) {
    logTurnEndDebug({ hook: eventName, phase: 'capture_skipped', success: false, reason: 'missing_session_capture_input' });
    return;
  }
  try {
    if (!sessionCaptureConfig.enabled) return;
    await captureSessionCheckpoint(nativeStore, {
      baseDir: runtimeBaseDir,
      thresholdTurns: sessionCaptureConfig.thresholdTurns,
      largeTurnChars: sessionCaptureConfig.largeTurnChars,
      idleFlushSeconds: sessionCaptureConfig.idleFlushSeconds,
      minTurns: sessionCaptureConfig.minTurns,
      generation: {
        baseUrl: summarizerConfig.generationBaseUrl,
        model: summarizerConfig.generationModel,
        fallbackModel: summarizerConfig.generationFallbackModel,
        timeoutMs: summarizerConfig.generationTimeoutMs,
        transport: summarizerConfig.generationTransport,
        requestOptions: summarizerConfig.ollamaNumCtx ? { options: { num_ctx: summarizerConfig.ollamaNumCtx } } : undefined,
      },
    }, input);
    logTurnEndDebug({ hook: eventName, phase: 'capture_completed', success: true });
  } catch (error) {
    logTurnEndDebug({
      hook: eventName,
      phase: 'capture_failed',
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
}

function truncateLine(value: string, maxChars = 220): string {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 1))}…`;
}

function formatContextLines(records: Array<{ content?: { text?: string }; identity?: { leafName?: string } }>, maxItems = 3): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const record of records) {
    const candidate = truncateLine(record.content?.text ?? record.identity?.leafName ?? '');
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    lines.push(`- ${candidate}`);
    if (lines.length >= maxItems) break;
  }
  return lines;
}

async function buildInitialByomemContext(prompt: string): Promise<string | null> {
  const userResults = await Promise.resolve(searchIndex(nativeStore, {
    query: 'working preferences repeated working style communication coding workflow progress updates subagents',
    scope: 'user',
    limit: 6,
  }));
  const projectResults = (await Promise.resolve(searchIndex(nativeStore, {
    query: `${prompt || 'current project'} architecture decisions conventions project context current repo`,
    scope: 'project',
    limit: 8,
  }))).filter((record) => record.provenance?.source !== 'session-capture' && record.identity?.namespace !== 'live-verification');

  const userLines = formatContextLines(userResults, 4);
  const projectLines = formatContextLines(projectResults, 4);
  if (!userLines.length && !projectLines.length) return null;

  const sections: string[] = ['## Remembered BYOMem context'];
  if (userLines.length) sections.push('### User preferences', ...userLines);
  if (projectLines.length) sections.push('### Project context', ...projectLines);
  return sections.join('\n');
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
    summarizerConfigSource: summarizerConfig.source,
    summarizerConfigPath: summarizerConfig.configPath,
    summarizerBaseUrl: summarizerConfig.generationBaseUrl,
    summarizerModel: summarizerConfig.generationModel,
    summarizerFallbackModel: summarizerConfig.generationFallbackModel,
    summarizerOllamaNumCtx: summarizerConfig.ollamaNumCtx,
    sessionCaptureConfigSource: sessionCaptureConfig.source,
    sessionCaptureEnabled: sessionCaptureConfig.enabled,
    sessionCaptureThresholdTurns: sessionCaptureConfig.thresholdTurns,
    sessionCaptureLargeTurnChars: sessionCaptureConfig.largeTurnChars,
    sessionCaptureIdleFlushSeconds: sessionCaptureConfig.idleFlushSeconds,
    sessionCaptureMinTurns: sessionCaptureConfig.minTurns,
  };
}

export default function (pi: ExtensionAPI) {
  pi.on('session_start', async (event, ctx) => {
    shouldInjectInitialContext = event.reason !== 'reload';
    ctx.ui?.notify?.('BYOMem TS runtime loaded', 'info');
  });
  pi.on('before_agent_start', async (event, _ctx) => {
    if (!shouldInjectInitialContext) return {};
    shouldInjectInitialContext = false;
    const rememberedContext = await buildInitialByomemContext(event.prompt ?? '');
    if (!rememberedContext) return {};
    return {
      systemPrompt: `${event.systemPrompt}\n\n${rememberedContext}`,
    };
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
