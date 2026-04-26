type ExtensionAPI = {
  on?: (event: string, handler: (event: any, ctx: any) => unknown) => void;
  registerCommand?: (name: string, options: { description?: string; handler: (args: any, ctx: any) => unknown }) => void;
  registerTool?: (tool: { name: string; label?: string; description?: string; parameters?: unknown; execute: (toolCallId: string, params: any) => unknown }) => void;
};
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertNoPythonDefaultPath as noPythonDefaultPath } from './no-python-default-path.js';
import { openQueueRuntime } from './queue-runtime.js';
import { openReadPath } from './read.js';
import { resolveRuntimeMode } from './runtime-mode.js';
import { searchIndex } from './search-index.js';
import { searchIndex as searchFileIndexForTool } from './file-search-query.js';
import { captureSessionCheckpoint, type SessionCaptureInput } from './session-capture.js';
import { openNativeStore } from './store.js';
import { resolveActiveProjectContext } from './identity.js';
import { listFileSearchProjects, markFileSearchProjectSeen, normalizeFileSearchPollingDisabledReason, registerFileSearchProject, unregisterFileSearchProject, type FileSearchPollingDisabledReason } from './file-search-project-registry.js';
import { openFileSearchDb, openFileSearchRegistryDb, type FileSearchDbHandle } from './file-search-db.js';
import { FileSearchActivePoller, disableFileSearchPolling, getFileSearchPollingStatus } from './file-search-active-poller.js';

function resolveDefaultRuntimeBaseDir(): string {
  return resolve(homedir(), '.byomem', 'runtime');
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
  fileSearchScanOnOpen: false,
  fileSearchSchedulerEnabled: false,
});
const readPath = openReadPath(nativeStore);
const queueRuntime = openQueueRuntime(nativeStore, { baseDir: runtimeBaseDir });
const debugLogPath = join(runtimeBaseDir, 'queue', 'debug', 'byomem-turn-end.jsonl');
let shouldInjectInitialContext = true;
let activeFileSearchPoller: FileSearchActivePoller | undefined;
let activeFileSearchPollingBaseDir: string | undefined;

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

function normalizeRequiredBaseDir(value: unknown): string {
  const baseDir = normalizeText(value);
  if (!baseDir) throw new Error('Invalid file-search project baseDir');
  return baseDir;
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

function resolveFileSearchTargetBaseDir(baseDir?: unknown): string {
  if (baseDir !== undefined) {
    const explicitBaseDir = normalizeText(baseDir);
    if (!explicitBaseDir) throw new Error('Invalid file-search project baseDir');
    return resolve(explicitBaseDir);
  }
  const activeProject = resolveActiveProjectContext(process.env, process.cwd());
  const resolved = normalizeText(activeProject.repoRoot);
  if (!resolved) throw new Error('Unable to resolve active project for file-search tool; provide baseDir');
  return resolve(resolved);
}

function normalizePositiveInteger(value: unknown, name: string, fallback?: number): number {
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Invalid ${name}: value is required`);
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new Error(`Invalid ${name}: must be a positive integer`);
  return value;
}

function resolveActivePollingTargetBaseDir(baseDir?: unknown): string {
  const cwd = process.cwd();
  if (!cwd.trim()) throw new Error('no-active-project: unable to resolve active project for file-search polling');
  const activeProject = resolveActiveProjectContext(process.env, cwd);
  const activeBaseDir = normalizeText(activeProject.repoRoot);
  if (!activeBaseDir) throw new Error('no-active-project: unable to resolve active project for file-search polling');
  if (baseDir === undefined) return resolve(activeBaseDir);
  const explicitBaseDir = normalizeText(baseDir);
  if (!explicitBaseDir) throw new Error('Invalid file-search project baseDir');
  const resolvedExplicit = resolve(explicitBaseDir);
  if (resolvedExplicit !== resolve(activeBaseDir)) throw new Error('not-active-project: file-search polling can only be enabled for the active project');
  return resolvedExplicit;
}

function openDirectFileSearchDb(targetBaseDir: string) {
  return openFileSearchDb({ baseDir: targetBaseDir, projectBaseDir: targetBaseDir, scanOnOpen: false, schedulerEnabled: false });
}

function openDirectFileSearchRegistryDb() {
  return openFileSearchRegistryDb({ dbBaseDir: process.env.BYOMEM_RUNTIME_BASE_DIR ?? runtimeBaseDir });
}

function serializeFileSearchResult(result: { id?: unknown; score?: unknown; file?: { projectKey?: unknown; path?: unknown; chunkIndex?: unknown; chunkText?: unknown; chunkHash?: unknown; lexicalScore?: unknown; semanticScore?: unknown } }) {
  const file = result.file;
  return {
    id: typeof result.id === 'string' ? result.id : undefined,
    score: typeof result.score === 'number' ? result.score : undefined,
    file: file ? {
      project_key: typeof file.projectKey === 'string' ? file.projectKey : undefined,
      path: typeof file.path === 'string' ? file.path : undefined,
      chunk_index: typeof file.chunkIndex === 'number' ? file.chunkIndex : undefined,
      chunk_text: typeof file.chunkText === 'string' ? file.chunkText : undefined,
      chunk_hash: typeof file.chunkHash === 'string' ? file.chunkHash : undefined,
      lexical_score: typeof file.lexicalScore === 'number' ? file.lexicalScore : undefined,
      semantic_score: typeof file.semanticScore === 'number' ? file.semanticScore : undefined,
    } : undefined,
  };
}

async function searchFileIndexDirect(targetBaseDir: string, query: { query: string; mode?: 'fts' | 'semantic' | 'hybrid'; limit?: number }) {
  const fileDb = openDirectFileSearchDb(targetBaseDir);
  try {
    const store = {
      baseDir: targetBaseDir,
      fileSearchDb: fileDb,
      fileSearchProjectBaseDir: targetBaseDir,
    } as never;
    const hits = await searchFileIndexForTool(store, query as never);
    return hits.map(serializeFileSearchResult);
  } finally {
    fileDb.close();
  }
}

function serializeScannerStatus(status: ReturnType<NonNullable<ReturnType<typeof openFileSearchDb>['getScannerStatus']>>) {
  return { scanner: status, status };
}

function serializeProjectEntry(entry: ReturnType<typeof listFileSearchProjects>[number]) {
  return {
    project_key: entry.projectKey,
    base_dir: entry.baseDir,
    display_name: entry.displayName,
    state: entry.state,
    source: entry.source,
    poll_interval_seconds: entry.pollIntervalSeconds,
    polling_enabled: entry.pollingEnabled,
    last_poll_at: entry.lastPollAt,
    next_poll_at: entry.nextPollAt,
    consecutive_no_change_polls: entry.consecutiveNoChangePolls,
    idle_disable_after_polls: entry.idleDisableAfterPolls,
    polling_disabled_reason: entry.pollingDisabledReason,
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
    last_seen_at: entry.lastSeenAt,
    registered_at: entry.registeredAt,
    last_scan_at: entry.lastScanAt,
    last_error: entry.lastError,
  };
}

function serializeProjectEntryList(entries: ReturnType<typeof listFileSearchProjects>) {
  return entries.map(serializeProjectEntry);
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

type ByomemSearchResultDto = {
  id?: string;
  scope?: string;
  identity?: {
    namespace?: string;
    leafName?: string;
    parentContext?: string;
  };
  text?: string;
  structured?: {
    kind?: string;
  };
  provenance?: {
    source?: string;
  };
};

function shapeByomemSearchResult<T extends { id?: unknown; scope?: unknown; identity?: { namespace?: unknown; leafName?: unknown; parentContext?: unknown }; content?: { text?: unknown; structured?: Record<string, unknown> }; provenance?: { source?: unknown } }>(result: T): ByomemSearchResultDto {
  const text = typeof result.content?.text === 'string' ? result.content.text : undefined;
  const kind = typeof result.content?.structured?.kind === 'string' ? result.content.structured.kind : undefined;
  const source = typeof result.provenance?.source === 'string' ? result.provenance.source : undefined;
  return {
    id: typeof result.id === 'string' ? result.id : undefined,
    scope: typeof result.scope === 'string' ? result.scope : undefined,
    identity: result.identity
      ? {
          namespace: typeof result.identity.namespace === 'string' ? result.identity.namespace : undefined,
          leafName: typeof result.identity.leafName === 'string' ? result.identity.leafName : undefined,
          parentContext: typeof result.identity.parentContext === 'string' ? result.identity.parentContext : undefined,
        }
      : undefined,
    text,
    ...(kind ? { structured: { kind } } : {}),
    ...(source ? { provenance: { source } } : {}),
  };
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

async function buildInitialByomemContext(prompt: string): Promise<{ visible?: string; systemPrompt?: string } | null> {
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
  const visible = sections.join('\n');
  const systemLines: string[] = ['## Remembered BYOMem steering'];
  if (userLines.length) systemLines.push(`- User preferences: ${userLines[0].replace(/^[-\s]+/, '')}`);
  if (projectLines.length) systemLines.push(`- Project context: ${projectLines[0].replace(/^[-\s]+/, '')}`);
  return { visible, systemPrompt: systemLines.join('\n') };
}

export function byomem_runtime_status() {
  const mode = resolveRuntimeMode();
  const activeProject = resolveActiveProjectContext(process.env, process.cwd());
  return {
    runtimeMode: mode,
    pythonDefaultDisabled: true,
    noPythonDefaultPath: (() => {
      try {
        noPythonDefaultPath('python-default');
        return false;
      } catch {
        return true;
      }
    })(),
    packageSurface: 'ts/packages/runtime',
    storeBaseDir: runtimeBaseDir,
    nativeStorePath: nativeStore.baseDir,
    activeProject,
    projectKey: activeProject.projectKey,
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
  pi.on?.('session_start', async (event, ctx) => {
    shouldInjectInitialContext = event.reason !== 'reload';
    ctx.ui?.notify?.('BYOMem TS runtime loaded', 'info');
  });
  pi.on?.('before_agent_start', async (event, ctx) => {
    if (!shouldInjectInitialContext) return {};
    shouldInjectInitialContext = false;
    const rememberedContext = await buildInitialByomemContext(event.prompt ?? '');
    if (!rememberedContext) return {};
    ctx.ui?.notify?.(rememberedContext.visible ?? rememberedContext.systemPrompt ?? '', 'info');
    return {
      systemPrompt: `${event.systemPrompt}\n\n${rememberedContext.systemPrompt ?? ''}`,
    };
  });
  pi.on?.('turn_end', async (event, ctx) => {
    await captureSessionFromHook('turn_end', ctx as Record<string, unknown>, event as TurnEndEvent);
  });
  pi.on?.('session_before_switch', async (event, ctx) => {
    await captureSessionFromHook('session_before_switch', ctx as Record<string, unknown>, event as TurnEndEvent);
  });
  const cleanupPollingForSessionEnd = async () => {
    if (!activeFileSearchPoller) return;
    activeFileSearchPoller.close('session-ended');
    activeFileSearchPoller = undefined;
    activeFileSearchPollingBaseDir = undefined;
  };
  pi.on?.('session_shutdown', async (event, ctx) => {
    await captureSessionFromHook('session_shutdown', ctx as Record<string, unknown>, event as TurnEndEvent);
    await cleanupPollingForSessionEnd();
  });
  pi.on?.('session:end', cleanupPollingForSessionEnd);
  pi.on?.('runtime:end', cleanupPollingForSessionEnd);
  pi.on?.('shutdown', cleanupPollingForSessionEnd);
  pi.on?.('dispose', cleanupPollingForSessionEnd);

  pi.registerTool?.({
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

  pi.registerTool?.({
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
      const results = (await Promise.resolve(searchIndex(nativeStore, { query, scope, limit }))).map((result) => shapeByomemSearchResult(result));
      return { content: [{ type: 'text', text: safeJson({ results }) }], details: { results } };
    },
  });

  pi.registerTool?.({
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
      const result = await queueRuntime.write(intent as never);
      if (!result?.record) throw new Error('Failed to persist byomem_store intent');
      return { content: [{ type: 'text', text: safeJson(result) }], details: result };
    },
  });

  pi.registerTool?.({
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
      const result = await queueRuntime.write({
        scope: intent.scope,
        identity: intent.identity,
        content: { text: `Prune ${intent.identity.leafName}` },
        provenance: { source: 'byomem-prune', adapter: 'native-store', origin: 'write' },
      } as never);
      if (!result?.record) throw new Error('Failed to persist byomem_prune intent');
      return { content: [{ type: 'text', text: safeJson(result) }], details: result };
    },
  });

  pi.registerTool?.({
    name: 'byomem_file_search',
    label: 'BYOMem File Search',
    description: 'Search indexed project files.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        mode: { type: 'string', enum: ['fts', 'semantic', 'hybrid'] },
        limit: { type: 'integer', minimum: 1 },
        baseDir: { type: 'string' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async execute(_toolCallId: string, params: unknown) {
      const intent = params as { query?: unknown; mode?: unknown; limit?: unknown; baseDir?: unknown };
      const query = normalizeText(intent?.query);
      if (!query) throw new Error('Invalid byomem_file_search intent: query is required');
      const mode = intent?.mode === undefined ? 'hybrid' : intent.mode;
      if (mode !== 'fts' && mode !== 'semantic' && mode !== 'hybrid') throw new Error('Invalid byomem_file_search intent: invalid mode');
      const limit = intent?.limit === undefined ? 10 : intent.limit;
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) throw new Error('Invalid byomem_file_search intent: limit must be a positive integer');
      const targetBaseDir = resolveFileSearchTargetBaseDir(intent?.baseDir);
      const results = await searchFileIndexDirect(targetBaseDir, { query, mode, limit });
      return { content: [{ type: 'text', text: safeJson({ results }) }], details: { results }, results };
    },
  });

  pi.registerTool?.({
    name: 'byomem_file_search_status',
    label: 'BYOMem File Search Status',
    description: 'Inspect scanner status for a project without scanning.',
    parameters: { type: 'object', properties: { baseDir: { type: 'string' } }, additionalProperties: false },
    async execute(_toolCallId: string, params: unknown) {
      const targetBaseDir = resolveFileSearchTargetBaseDir((params as { baseDir?: unknown })?.baseDir);
      const fileDb = openDirectFileSearchDb(targetBaseDir);
      try {
        const scanner = fileDb.getScannerStatus();
        markFileSearchProjectSeen(fileDb.db, targetBaseDir, 'manual-status');
        const payload = serializeScannerStatus(scanner);
        return { content: [{ type: 'text', text: safeJson(payload) }], details: payload, ...payload };
      } finally {
        fileDb.close();
      }
    },
  });

  pi.registerTool?.({
    name: 'byomem_file_search_scan',
    label: 'BYOMem File Search Scan',
    description: 'Trigger one manual file-search scan for a project.',
    parameters: { type: 'object', properties: { baseDir: { type: 'string' } }, additionalProperties: false },
    async execute(_toolCallId: string, params: unknown) {
      const targetBaseDir = resolveFileSearchTargetBaseDir((params as { baseDir?: unknown })?.baseDir);
      const fileDb = openDirectFileSearchDb(targetBaseDir);
      try {
        fileDb.scanAndIndex({ trigger: 'manual' });
        const scanner = fileDb.getScannerStatus();
        const payload = serializeScannerStatus(scanner);
        return { content: [{ type: 'text', text: safeJson(payload) }], details: payload, ...payload };
      } finally {
        fileDb.close();
      }
    },
  });

  pi.registerTool?.({
    name: 'byomem_file_search_polling_status',
    label: 'BYOMem File Search Polling Status',
    description: 'Inspect active-project file-search polling state without scanning.',
    parameters: { type: 'object', properties: { baseDir: { type: 'string' } }, additionalProperties: false },
    async execute(_toolCallId: string, params: unknown) {
      const targetBaseDir = resolveFileSearchTargetBaseDir((params as { baseDir?: unknown })?.baseDir);
      const polling = getFileSearchPollingStatus(targetBaseDir, { dbBaseDir: process.env.BYOMEM_RUNTIME_BASE_DIR ?? runtimeBaseDir });
      const payload = { polling, status: polling };
      return { content: [{ type: 'text', text: safeJson(payload) }], details: payload, ...payload };
    },
  });

  pi.registerTool?.({
    name: 'byomem_file_search_polling_enable',
    label: 'BYOMem File Search Polling Enable',
    description: 'Enable session-owned active-project file-search polling.',
    parameters: {
      type: 'object',
      properties: {
        baseDir: { type: 'string' },
        pollIntervalSeconds: { type: 'integer', minimum: 1 },
        idleDisableAfterPolls: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId: string, params: unknown) {
      const intent = params as { baseDir?: unknown; pollIntervalSeconds?: unknown; idleDisableAfterPolls?: unknown };
      const targetBaseDir = resolveActivePollingTargetBaseDir(intent?.baseDir);
      const pollIntervalSeconds = normalizePositiveInteger(intent?.pollIntervalSeconds, 'pollIntervalSeconds', 60);
      const idleDisableAfterPolls = intent?.idleDisableAfterPolls === undefined ? undefined : normalizePositiveInteger(intent.idleDisableAfterPolls, 'idleDisableAfterPolls');
      if (activeFileSearchPoller) activeFileSearchPoller.stop(activeFileSearchPollingBaseDir === targetBaseDir ? 'manually-disabled' : 'not-active-project');
      activeFileSearchPoller = new FileSearchActivePoller({
        baseDir: targetBaseDir,
        pollIntervalSeconds,
        idleDisableAfterPolls,
        dbBaseDir: process.env.BYOMEM_RUNTIME_BASE_DIR ?? runtimeBaseDir,
        embeddingBaseUrl: embeddingConfig.embeddingBaseUrl,
        embeddingModel: embeddingConfig.embeddingModel,
        embeddingTimeoutMs: embeddingConfig.embeddingTimeoutMs,
        embeddingRequireRemote: Boolean(embeddingConfig.embeddingBaseUrl),
        semanticSearchEnabled: false,
      });
      activeFileSearchPollingBaseDir = targetBaseDir;
      const polling = activeFileSearchPoller.start();
      const payload = { polling, status: polling };
      return { content: [{ type: 'text', text: safeJson(payload) }], details: payload, ...payload };
    },
  });

  pi.registerTool?.({
    name: 'byomem_file_search_polling_disable',
    label: 'BYOMem File Search Polling Disable',
    description: 'Disable session-owned active-project file-search polling.',
    parameters: { type: 'object', properties: { baseDir: { type: 'string' }, reason: { type: 'string' } }, additionalProperties: false },
    async execute(_toolCallId: string, params: unknown) {
      const intent = params as { baseDir?: unknown; reason?: unknown };
      const targetBaseDir = resolveActivePollingTargetBaseDir(intent?.baseDir);
      const reasonText = normalizeText(intent?.reason);
      const reason = reasonText ? normalizeFileSearchPollingDisabledReason(reasonText) : 'manually-disabled';
      const polling = activeFileSearchPoller && activeFileSearchPollingBaseDir === targetBaseDir
        ? activeFileSearchPoller.stop(reason)
        : disableFileSearchPolling(targetBaseDir, reason, { dbBaseDir: process.env.BYOMEM_RUNTIME_BASE_DIR ?? runtimeBaseDir });
      if (activeFileSearchPollingBaseDir === targetBaseDir) {
        activeFileSearchPoller = undefined;
        activeFileSearchPollingBaseDir = undefined;
      }
      const payload = { polling, status: polling };
      return { content: [{ type: 'text', text: safeJson(payload) }], details: payload, ...payload };
    },
  });

  pi.registerTool?.({
    name: 'byomem_file_search_project_register',
    label: 'BYOMem File Search Project Register',
    description: 'Register a project for file search.',
    parameters: { type: 'object', properties: { baseDir: { type: 'string' } }, required: ['baseDir'], additionalProperties: false },
    async execute(_toolCallId: string, params: unknown) {
      const baseDir = normalizeRequiredBaseDir((params as { baseDir?: unknown })?.baseDir);
      const registryDb = openDirectFileSearchRegistryDb();
      try {
        const project = registerFileSearchProject(registryDb.db, baseDir);
        const serialized = serializeProjectEntry(project);
        return { content: [{ type: 'text', text: safeJson(serialized) }], details: serialized, ...serialized };
      } finally {
        registryDb.close();
      }
    },
  });

  pi.registerTool?.({
    name: 'byomem_file_search_project_list',
    label: 'BYOMem File Search Project List',
    description: 'List registered file-search projects.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const registryDb = openDirectFileSearchRegistryDb();
      try {
        const projects = serializeProjectEntryList(listFileSearchProjects(registryDb.db));
        const result = { projects };
        return { content: [{ type: 'text', text: safeJson(result) }], details: result, ...result };
      } finally {
        registryDb.close();
      }
    },
  });

  pi.registerTool?.({
    name: 'byomem_file_search_project_unregister',
    label: 'BYOMem File Search Project Unregister',
    description: 'Soft-disable a registered file-search project.',
    parameters: { type: 'object', properties: { baseDir: { type: 'string' } }, required: ['baseDir'], additionalProperties: false },
    async execute(_toolCallId: string, params: unknown) {
      const baseDir = normalizeRequiredBaseDir((params as { baseDir?: unknown })?.baseDir);
      const registryDb = openDirectFileSearchRegistryDb();
      try {
        const project = unregisterFileSearchProject(registryDb.db, baseDir);
        const serialized = serializeProjectEntry(project);
        return { content: [{ type: 'text', text: safeJson(serialized) }], details: serialized, ...serialized };
      } finally {
        registryDb.close();
      }
    },
  });

  pi.registerCommand?.('byomem-status', {
    description: 'Show repo-local BYOMem TS runtime status',
    handler: async (_args: string, ctx) => {
      ctx.ui.notify(JSON.stringify(byomem_runtime_status(), null, 2), 'info');
    },
  });
}
