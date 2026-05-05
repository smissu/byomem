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
import { buildSearchSemanticMetadata, findRelated as findRelatedFileIndex, searchIndex as searchFileIndexForTool } from './file-search-query.js';
import { refreshSemanticIndexAfterManualScan } from './file-search-semantic-refresh.js';
import { buildFileSearchIndex } from './file-search-index.js';
import { captureSessionCheckpoint, type SessionCaptureInput } from './session-capture.js';
import { openNativeStore } from './store.js';
import { resolveActiveProjectContext } from './identity.js';
import { listFileSearchProjects, markFileSearchProjectSeen, normalizeFileSearchPollingDisabledReason, registerFileSearchProject, unregisterFileSearchProject, type FileSearchPollingDisabledReason } from './file-search-project-registry.js';
import { openFileSearchDb, openFileSearchRegistryDb, resolveFileSearchProjectKey } from './file-search-db.js';
import { FileSearchActivePoller, disableFileSearchPolling, getFileSearchPollingStatus } from './file-search-active-poller.js';
import { FileSearchScanManager } from './file-search-scan-manager.js';

function resolveDefaultRuntimeBaseDir(): string {
  return resolve(homedir(), '.byomem', 'runtime');
}

const runtimeBaseDir = process.env.BYOMEM_RUNTIME_BASE_DIR ?? resolveDefaultRuntimeBaseDir();
const embeddingConfig = resolveEmbeddingConfig();
const sessionCaptureConfig = resolveSessionCaptureConfig();
const summarizerConfig = resolveSummarizerConfig();
const fileSearchConfig = resolveFileSearchConfig();
const nativeStore = openNativeStore({
  baseDir: runtimeBaseDir,
  embeddingBaseUrl: embeddingConfig.embeddingBaseUrl,
  embeddingModel: embeddingConfig.embeddingModel,
  embeddingDimension: embeddingConfig.embeddingDimension,
  embeddingTimeoutMs: embeddingConfig.embeddingTimeoutMs,
  embeddingRequireRemote: Boolean(embeddingConfig.embeddingBaseUrl),
  fileSearchEmbeddingBatchSize: fileSearchConfig.embeddingBatchSize,
  fileSearchEmbeddingConcurrency: fileSearchConfig.embeddingConcurrency,
  fileSearchScanOnOpen: false,
  fileSearchSchedulerEnabled: false,
  fileSearchScannerExcludedExtensions: fileSearchConfig.excludedExtensions,
  fileSearchBinaryDetectionEnabled: fileSearchConfig.binaryDetectionEnabled,
  fileSearchIncludeTextFiles: fileSearchConfig.includeTextFiles,
  fileSearchIndexStorageMode: fileSearchConfig.indexStorageMode,
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
  embeddingDimension?: number;
  embeddingTimeoutMs?: number;
}

export interface ByomemFileSearchConfig {
  source: 'config' | 'env' | 'default';
  configPath?: string;
  excludedExtensions?: string[];
  binaryDetectionEnabled?: boolean;
  includeTextFiles?: boolean;
  embeddingBatchSize?: number;
  embeddingConcurrency?: number;
  indexStorageMode?: 'disk' | 'memory';
}

const SENSITIVE_OUTPUT_KEYS = new Set(['thinkingSignature', 'textSignature', 'encrypted_content', 'encryptedContent']);
const SENSITIVE_OUTPUT_TEXT_PATTERN = /["'](?:thinkingSignature|textSignature|encrypted_content|encryptedContent)["']\s*:/;

function redactSensitiveOutput(value: unknown): unknown {
  if (typeof value === 'string') {
    return SENSITIVE_OUTPUT_TEXT_PATTERN.test(value) ? '[REDACTED]' : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactSensitiveOutput(item));
  if (!value || typeof value !== 'object') return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_OUTPUT_KEYS.has(key)) continue;
    redacted[key] = redactSensitiveOutput(nestedValue);
  }
  return redacted;
}

function safeJson(value: unknown): string {
  return JSON.stringify(redactSensitiveOutput(value), null, 2);
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
  return openFileSearchDb({
    baseDir: targetBaseDir,
    projectBaseDir: targetBaseDir,
    dbBaseDir: process.env.BYOMEM_RUNTIME_BASE_DIR ?? runtimeBaseDir,
    embeddingBaseUrl: embeddingConfig.embeddingBaseUrl,
    embeddingModel: embeddingConfig.embeddingModel,
    embeddingDimension: embeddingConfig.embeddingDimension,
    embeddingTimeoutMs: embeddingConfig.embeddingTimeoutMs,
    embeddingRequireRemote: Boolean(embeddingConfig.embeddingBaseUrl),
    semanticSearchEnabled: true,
    embeddingBatchSize: fileSearchConfig.embeddingBatchSize,
    embeddingConcurrency: fileSearchConfig.embeddingConcurrency,
    scanOnOpen: false,
    schedulerEnabled: false,
    scannerExcludedExtensions: fileSearchConfig.excludedExtensions,
    scannerBinaryDetectionEnabled: fileSearchConfig.binaryDetectionEnabled,
    scannerIncludeTextFiles: fileSearchConfig.includeTextFiles ?? true,
    storageMode: fileSearchConfig.indexStorageMode,
  });
}

function openDirectFileSearchRegistryDb() {
  return openFileSearchRegistryDb({ dbBaseDir: process.env.BYOMEM_RUNTIME_BASE_DIR ?? runtimeBaseDir });
}

type DirectFileSearchStore = {
  baseDir: string;
  fileSearchDb: ReturnType<typeof openFileSearchDb>;
  fileSearchProjectBaseDir: string;
};

const directFileSearchStores = new Map<string, DirectFileSearchStore>();
let directFileSearchStoreIdleTimer: ReturnType<typeof setTimeout> | undefined;

function getDirectFileSearchStore(targetBaseDir: string): DirectFileSearchStore {
  if (directFileSearchStoreIdleTimer) {
    clearTimeout(directFileSearchStoreIdleTimer);
    directFileSearchStoreIdleTimer = undefined;
  }
  const existing = directFileSearchStores.get(targetBaseDir);
  if (existing) return existing;
  const store = {
    baseDir: targetBaseDir,
    fileSearchDb: openDirectFileSearchDb(targetBaseDir),
    fileSearchProjectBaseDir: targetBaseDir,
  };
  directFileSearchStores.set(targetBaseDir, store);
  return store;
}

function closeDirectFileSearchStores(): void {
  if (directFileSearchStoreIdleTimer) {
    clearTimeout(directFileSearchStoreIdleTimer);
    directFileSearchStoreIdleTimer = undefined;
  }
  for (const store of directFileSearchStores.values()) store.fileSearchDb.close();
  directFileSearchStores.clear();
}

function scheduleDirectFileSearchStoreIdleCleanup(): void {
  if (directFileSearchStoreIdleTimer) clearTimeout(directFileSearchStoreIdleTimer);
  directFileSearchStoreIdleTimer = setTimeout(() => closeDirectFileSearchStores(), 1_000);
  directFileSearchStoreIdleTimer.unref?.();
}

async function withDirectFileSearchStore<T>(targetBaseDir: string, fn: (store: DirectFileSearchStore) => Promise<T> | T): Promise<T> {
  const store = getDirectFileSearchStore(targetBaseDir);
  try {
    return await fn(store);
  } finally {
    scheduleDirectFileSearchStoreIdleCleanup();
  }
}

let runtimeFileSearchScanManager: FileSearchScanManager | undefined;

function getRuntimeFileSearchScanManager(): FileSearchScanManager {
  runtimeFileSearchScanManager ??= new FileSearchScanManager({
    concurrency: 1,
    scanRunner: async (request) => {
      return withDirectFileSearchStore(request.baseDir, async (store) => {
        const fileDb = store.fileSearchDb;
        fileDb.scanAndIndex({ trigger: request.trigger });
        await refreshSemanticIndexAfterManualScan(fileDb, {
          concurrency: fileSearchConfig.embeddingConcurrency,
        });
        return fileDb.getScannerStatus();
      });
    },
    statusReader: (request) => {
      try {
        return getDirectFileSearchStore(request.baseDir).fileSearchDb.getScannerStatus();
      } finally {
        scheduleDirectFileSearchStoreIdleCleanup();
      }
    },
  });
  return runtimeFileSearchScanManager;
}

function serializeFileSearchResult(result: { chunk?: { filePath?: unknown; content?: unknown; startLine?: unknown; endLine?: unknown; language?: unknown }; score?: unknown; source?: unknown }) {
  return {
    score: typeof result.score === 'number' ? result.score : undefined,
    source: typeof result.source === 'string' ? result.source : undefined,
    chunk: result.chunk ? {
      filePath: typeof result.chunk.filePath === 'string' ? result.chunk.filePath : undefined,
      content: typeof result.chunk.content === 'string' ? result.chunk.content : undefined,
      startLine: typeof result.chunk.startLine === 'number' ? result.chunk.startLine : undefined,
      endLine: typeof result.chunk.endLine === 'number' ? result.chunk.endLine : undefined,
      ...(typeof result.chunk.language === 'string' ? { language: result.chunk.language } : {}),
    } : undefined,
  };
}

async function searchFileIndexDirect(targetBaseDir: string, query: { query: string; mode?: 'bm25' | 'semantic' | 'hybrid'; limit?: number }) {
  return withDirectFileSearchStore(targetBaseDir, async (store) => {
    const hits = await searchFileIndexForTool(store as never, query as never);
    const results = hits.map(serializeFileSearchResult);
    const semantic = await buildSearchSemanticMetadata(store as never, query as never, hits);
    const index = buildFileSearchIndex(store as never).stats();
    return { results, semantic, index };
  });
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

function parseConfigYaml(content: string): { embeddings?: { base_url?: string; model?: string; dimension?: string; request_timeout?: number }; summarizer?: { base_url?: string; model?: string; fallback_model?: string; max_tokens?: number; ollama_num_ctx?: number }; session_capture?: { enabled?: boolean; threshold_turns?: number; large_turn_chars?: number; idle_flush_seconds?: number; min_turns?: number } } {
  const embeddingsBlock = extractYamlBlock(content, 'embeddings') ?? '';
  const summarizerBlock = extractYamlBlock(content, 'summarizer') ?? '';
  const sessionCaptureBlock = extractYamlBlock(content, 'session_capture') ?? '';
  const parseBool = (value: string | undefined) => value?.trim() === 'true' ? true : value?.trim() === 'false' ? false : undefined;
  return {
    embeddings: {
      base_url: embeddingsBlock.match(/base_url:\s*(.+)/)?.[1]?.trim(),
      model: embeddingsBlock.match(/model:\s*(.+)/)?.[1]?.trim(),
      dimension: embeddingsBlock.match(/dimension:\s*(.+)/)?.[1]?.trim(),
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

function parsePositiveSafeIntegerConfig(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const raw = value.trim();
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseBooleanText(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${name} must be true or false`);
}

function parseStorageModeText(value: string | undefined, name: string): 'disk' | 'memory' | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'disk' || normalized === 'memory') return normalized;
  throw new Error(`${name} must be disk or memory`);
}

function parseCommaSeparatedTextList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(',').map((part) => part.trim()).filter(Boolean);
}

function parseYamlListToken(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const quoted = trimmed.match(/^(['"])(.*)\1$/s)?.[2]?.trim();
  return quoted !== undefined ? quoted : trimmed;
}

function parseYamlListTokens(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(',').map((part) => parseYamlListToken(part)).filter((part): part is string => Boolean(part));
}

function parseFileSearchYamlConfig(block: string): { excludedExtensions?: string[]; binaryDetectionEnabled?: boolean; includeTextFiles?: boolean; embeddingBatchSize?: number; embeddingConcurrency?: number; indexStorageMode?: 'disk' | 'memory' } {
  const binaryDetectionEnabled = parseBooleanText(block.match(/binary_detection:\s*([^\n]+)/)?.[1]?.trim(), 'file_search.binary_detection');
  const includeTextFiles = parseBooleanText(block.match(/include_text_files:\s*([^\n]+)/)?.[1]?.trim(), 'file_search.include_text_files');
  const embeddingBatchSize = parsePositiveSafeIntegerConfig(block.match(/embedding_batch_size:\s*([^\n]+)/)?.[1]?.trim(), 'file_search.embedding_batch_size');
  const embeddingConcurrency = parsePositiveSafeIntegerConfig(block.match(/embedding_concurrency:\s*([^\n]+)/)?.[1]?.trim(), 'file_search.embedding_concurrency');
  const indexStorageMode = parseStorageModeText(block.match(/(?:index_storage_mode|storage_mode):\s*([^\n]+)/)?.[1]?.trim(), 'file_search.index_storage_mode');
  const bracketed = block.match(/excluded_extensions:\s*\[(.*?)\]/s)?.[1];
  if (bracketed !== undefined) {
    return {
      excludedExtensions: parseYamlListTokens(bracketed),
      ...(embeddingBatchSize !== undefined ? { embeddingBatchSize } : {}),
      ...(embeddingConcurrency !== undefined ? { embeddingConcurrency } : {}),
      ...(indexStorageMode !== undefined ? { indexStorageMode } : {}),
      ...(binaryDetectionEnabled !== undefined ? { binaryDetectionEnabled } : {}),
    };
  }
  const multiline = block.match(/excluded_extensions:\s*\n((?:\s*-\s*.*\n?)+)/)?.[1];
  if (multiline) {
    return {
      excludedExtensions: multiline
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s*-\s*/, '').trim())
        .map((line) => parseYamlListToken(line))
      .filter((line): line is string => Boolean(line)),
      ...(embeddingBatchSize !== undefined ? { embeddingBatchSize } : {}),
      ...(embeddingConcurrency !== undefined ? { embeddingConcurrency } : {}),
      ...(indexStorageMode !== undefined ? { indexStorageMode } : {}),
      ...(binaryDetectionEnabled !== undefined ? { binaryDetectionEnabled } : {}),
    };
  }
  const inlineExcluded = block.match(/excluded_extensions:\s*([^\n]+)/)?.[1]?.trim();
  return {
    ...(inlineExcluded ? { excludedExtensions: parseYamlListTokens(inlineExcluded) } : {}),
    ...(block.match(/excluded_extensions:\s*$/m) ? { excludedExtensions: [] } : {}),
    ...(embeddingBatchSize !== undefined ? { embeddingBatchSize } : {}),
    ...(embeddingConcurrency !== undefined ? { embeddingConcurrency } : {}),
    ...(indexStorageMode !== undefined ? { indexStorageMode } : {}),
    ...(binaryDetectionEnabled !== undefined ? { binaryDetectionEnabled } : {}),
    ...(includeTextFiles !== undefined ? { includeTextFiles } : {}),
  };
}

function resolveFileSearchConfig(): ByomemFileSearchConfig {
  const configPath = resolveConfigPath();
  const configContent = existsSync(configPath) ? readFileSync(configPath, 'utf8') : undefined;
  const configBlock = configContent ? extractYamlBlock(configContent, 'file_search') : undefined;
  const envExcludedExtensions = process.env.BYOMEM_FILE_SEARCH_EXCLUDED_EXTENSIONS;
  const envBinaryDetection = process.env.BYOMEM_FILE_SEARCH_BINARY_DETECTION;
  const envIncludeTextFiles = process.env.BYOMEM_FILE_SEARCH_INCLUDE_TEXT_FILES;
  const envEmbeddingBatchSize = process.env.BYOMEM_FILE_SEARCH_EMBEDDING_BATCH_SIZE;
  const envEmbeddingConcurrency = process.env.BYOMEM_FILE_SEARCH_EMBEDDING_CONCURRENCY;
  const envIndexStorageMode = process.env.BYOMEM_FILE_SEARCH_INDEX_STORAGE_MODE;
  const hasEnv = envExcludedExtensions !== undefined || envBinaryDetection !== undefined || envIncludeTextFiles !== undefined || envEmbeddingBatchSize !== undefined || envEmbeddingConcurrency !== undefined || envIndexStorageMode !== undefined;
  const parsedConfig = configBlock ? parseFileSearchYamlConfig(configBlock) : undefined;
  const excludedExtensions = hasEnv
    ? parseCommaSeparatedTextList(envExcludedExtensions) ?? parsedConfig?.excludedExtensions
    : parsedConfig?.excludedExtensions;
  const binaryDetectionEnabled = hasEnv
    ? parseBooleanText(envBinaryDetection, 'BYOMEM_FILE_SEARCH_BINARY_DETECTION') ?? parsedConfig?.binaryDetectionEnabled
    : parsedConfig?.binaryDetectionEnabled;
  const includeTextFiles = hasEnv
    ? parseBooleanText(envIncludeTextFiles, 'BYOMEM_FILE_SEARCH_INCLUDE_TEXT_FILES') ?? parsedConfig?.includeTextFiles
    : parsedConfig?.includeTextFiles;
  const embeddingBatchSize = hasEnv
    ? parsePositiveSafeIntegerConfig(envEmbeddingBatchSize, 'BYOMEM_FILE_SEARCH_EMBEDDING_BATCH_SIZE') ?? parsedConfig?.embeddingBatchSize
    : parsedConfig?.embeddingBatchSize;
  const embeddingConcurrency = hasEnv
    ? parsePositiveSafeIntegerConfig(envEmbeddingConcurrency, 'BYOMEM_FILE_SEARCH_EMBEDDING_CONCURRENCY') ?? parsedConfig?.embeddingConcurrency
    : parsedConfig?.embeddingConcurrency;
  const indexStorageMode = hasEnv
    ? parseStorageModeText(envIndexStorageMode, 'BYOMEM_FILE_SEARCH_INDEX_STORAGE_MODE') ?? parsedConfig?.indexStorageMode
    : parsedConfig?.indexStorageMode;
  if (hasEnv || configBlock) {
    return {
      source: hasEnv ? 'env' : 'config',
      configPath: configBlock ? configPath : undefined,
      excludedExtensions,
      binaryDetectionEnabled,
      includeTextFiles,
      embeddingBatchSize,
      embeddingConcurrency,
      indexStorageMode,
    };
  }
  return { source: 'default' };
}

function resolveEmbeddingConfig(): ByomemEmbeddingConfig {
  const configPath = resolveConfigPath();
  const parsed = existsSync(configPath) ? parseConfigYaml(readFileSync(configPath, 'utf8')) : undefined;
  const envBaseUrl = process.env.BYOMEM_EMBEDDING_BASE_URL;
  const envModel = process.env.BYOMEM_EMBEDDING_MODEL;
  const envTimeout = process.env.BYOMEM_EMBEDDING_TIMEOUT_MS;
  const envDimension = process.env.BYOMEM_EMBEDDING_DIMENSION;
  const hasEnv = Boolean(envBaseUrl || envModel || envTimeout || envDimension);
  if (hasEnv || parsed) {
    return {
      source: hasEnv ? 'env' : 'config',
      configPath: parsed ? configPath : undefined,
      embeddingBaseUrl: envBaseUrl ?? parsed?.embeddings?.base_url,
      embeddingModel: envModel ?? parsed?.embeddings?.model,
      embeddingDimension: parsePositiveSafeIntegerConfig(envDimension ?? parsed?.embeddings?.dimension, 'embedding dimension'),
      embeddingTimeoutMs: envTimeout ? Number(envTimeout) : parsed?.embeddings?.request_timeout,
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
    embeddingDimension: embeddingConfig.embeddingDimension,
    embeddingTimeoutMs: embeddingConfig.embeddingTimeoutMs,
    embeddingRequireRemote: Boolean(embeddingConfig.embeddingBaseUrl),
    fileSearchConfigSource: fileSearchConfig.source,
    fileSearchConfigPath: fileSearchConfig.configPath,
    fileSearchScannerExcludedExtensions: fileSearchConfig.excludedExtensions,
    fileSearchBinaryDetectionEnabled: fileSearchConfig.binaryDetectionEnabled,
    fileSearchEmbeddingBatchSize: fileSearchConfig.embeddingBatchSize,
    fileSearchEmbeddingConcurrency: fileSearchConfig.embeddingConcurrency,
    fileSearchIndexStorageMode: fileSearchConfig.indexStorageMode,
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
  const cleanupForSessionEnd = async () => {
    if (activeFileSearchPoller) {
      activeFileSearchPoller.close('session-ended');
      activeFileSearchPoller = undefined;
      activeFileSearchPollingBaseDir = undefined;
    }
    closeDirectFileSearchStores();
  };
  pi.on?.('session_shutdown', async (event, ctx) => {
    await captureSessionFromHook('session_shutdown', ctx as Record<string, unknown>, event as TurnEndEvent);
    await cleanupForSessionEnd();
  });
  pi.on?.('session:end', cleanupForSessionEnd);
  pi.on?.('runtime:end', cleanupForSessionEnd);
  pi.on?.('shutdown', cleanupForSessionEnd);
  pi.on?.('dispose', cleanupForSessionEnd);

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
        mode: { type: 'string', enum: ['bm25', 'semantic', 'hybrid'] },
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
      if (mode !== 'bm25' && mode !== 'semantic' && mode !== 'hybrid') throw new Error('Invalid byomem_file_search intent: invalid mode');
      const limit = intent?.limit === undefined ? 10 : intent.limit;
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) throw new Error('Invalid byomem_file_search intent: limit must be a positive integer');
      const targetBaseDir = resolveFileSearchTargetBaseDir(intent?.baseDir);
      const payload = await searchFileIndexDirect(targetBaseDir, { query, mode, limit });
      return { content: [{ type: 'text', text: safeJson(payload) }], details: payload, ...payload };
    },
  });

  pi.registerTool?.({
    name: 'byomem_file_search_find_related',
    label: 'BYOMem File Search Related',
    description: 'Find Semble-style related chunks for a file path and line number.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string' },
        line: { type: 'integer', minimum: 1 },
        limit: { type: 'integer', minimum: 1 },
        baseDir: { type: 'string' },
      },
      required: ['filePath', 'line'],
      additionalProperties: false,
    },
    async execute(_toolCallId: string, params: unknown) {
      const intent = params as { filePath?: unknown; line?: unknown; limit?: unknown; baseDir?: unknown };
      const filePath = normalizeText(intent?.filePath);
      if (!filePath) throw new Error('Invalid byomem_file_search_find_related intent: filePath is required');
      const line = intent?.line === undefined ? undefined : normalizePositiveInteger(intent.line, 'line');
      if (line === undefined) throw new Error('Invalid byomem_file_search_find_related intent: line is required');
      const limit = intent?.limit === undefined ? 5 : normalizePositiveInteger(intent.limit, 'limit');
      const targetBaseDir = resolveFileSearchTargetBaseDir(intent?.baseDir);
      return withDirectFileSearchStore(targetBaseDir, async (store) => {
        const results = (await findRelatedFileIndex(store as never, { filePath, line, limit })).map(serializeFileSearchResult);
        const index = buildFileSearchIndex(store as never).stats();
        const payload = { results, index };
        return { content: [{ type: 'text', text: safeJson(payload) }], details: payload, ...payload };
      });
    },
  });

  
  pi.registerTool?.({
    name: 'byomem_file_search_semantic_refresh',
    label: 'BYOMem File Search Semantic Refresh',
    description: 'Refresh semantic embeddings for one project without scanning or searching.',
    parameters: {
      type: 'object',
      properties: {
        baseDir: { type: 'string' },
        limit: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId: string, params: unknown) {
      const intent = params as { baseDir?: unknown; limit?: unknown };
      const targetBaseDir = resolveFileSearchTargetBaseDir(intent?.baseDir);
      const limit = intent?.limit === undefined ? undefined : normalizePositiveInteger(intent.limit, 'limit');
      return withDirectFileSearchStore(targetBaseDir, async (store) => {
        const diagnostics = await store.fileSearchDb.refreshSemanticIndex({ limit });
        const refresh = { tool: 'byomem_file_search_semantic_refresh', baseDir: diagnostics.baseDir, projectKey: diagnostics.projectKey, limit };
        const index = buildFileSearchIndex(store as never).stats();
        const payload = { details: { refresh, diagnostics, embeddings: diagnostics, index }, refresh, diagnostics, embeddings: diagnostics, index };
        return { content: [{ type: 'text', text: safeJson(payload) }], ...payload };
      });
    },
  });

  pi.registerTool?.({
    name: 'byomem_file_search_status',
    label: 'BYOMem File Search Status',
    description: 'Inspect scanner status and runtime-local async scan jobs for a project without scanning.',
    parameters: { type: 'object', properties: { baseDir: { type: 'string' }, jobId: { type: 'string' } }, additionalProperties: false },
    async execute(_toolCallId: string, params: unknown) {
      const intent = params as { baseDir?: unknown; jobId?: unknown };
      const jobId = normalizeText(intent?.jobId);
      const manager = getRuntimeFileSearchScanManager();
      if (jobId) {
        const jobStatus = manager.getJobStatus(jobId);
        const payload = { job_status: jobStatus, job: jobStatus.job, scanner: jobStatus.job?.scanner ?? null, status: jobStatus.job?.scanner ?? null };
        return { content: [{ type: 'text', text: safeJson(payload) }], details: payload, ...payload };
      }
      const targetBaseDir = resolveFileSearchTargetBaseDir(intent?.baseDir);
      return withDirectFileSearchStore(targetBaseDir, (store) => {
        const scanner = store.fileSearchDb.getScannerStatus();
        const activeJob = manager.getProjectActiveJob(scanner.projectKey) ?? null;
        const latestJob = manager.getProjectLatestJob(scanner.projectKey) ?? null;
        const index = buildFileSearchIndex(store as never).stats();
        const payload = { ...serializeScannerStatus(scanner), index, job: latestJob, runtime_local_jobs: { active: activeJob, latest: latestJob, durable: false } };
        return { content: [{ type: 'text', text: safeJson(payload) }], details: payload, ...payload };
      });
    },
  });

  pi.registerTool?.({
    name: 'byomem_file_search_scan',
    label: 'BYOMem File Search Scan',
    description: 'Trigger one manual file-search scan for a project. Explicit async mode is runtime-local and not durable.',
    parameters: { type: 'object', properties: { baseDir: { type: 'string' }, async: { type: 'boolean' }, wait: { type: 'boolean' } }, additionalProperties: false },
    async execute(_toolCallId: string, params: unknown) {
      const intent = params as { baseDir?: unknown; async?: unknown; wait?: unknown };
      if (intent?.async !== undefined && typeof intent.async !== 'boolean') throw new Error('Invalid async: must be a boolean');
      if (intent?.wait !== undefined && typeof intent.wait !== 'boolean') throw new Error('Invalid wait: must be a boolean');
      const targetBaseDir = resolveFileSearchTargetBaseDir(intent?.baseDir);
      const wantsAsync = intent?.async === true || intent?.wait === false;
      if (wantsAsync) {
        const manager = getRuntimeFileSearchScanManager();
        const job = manager.enqueueScan({ projectKey: resolveFileSearchProjectKey(targetBaseDir), baseDir: targetBaseDir, trigger: 'manual' });
        const payload = { job, scanner: job.scanner ?? null, status: job.scanner ?? null, runtime_local: true, durable: false };
        return { content: [{ type: 'text', text: safeJson(payload) }], details: payload, ...payload };
      }
      return withDirectFileSearchStore(targetBaseDir, async (store) => {
        const fileDb = store.fileSearchDb;
        fileDb.scanAndIndex({ trigger: 'manual' });
        const refresh = await refreshSemanticIndexAfterManualScan(fileDb, {
          concurrency: fileSearchConfig.embeddingConcurrency,
        });
        const scanner = fileDb.getScannerStatus();
        const index = buildFileSearchIndex(store as never).stats();
        const payload = { ...serializeScannerStatus(scanner), refresh, diagnostics: refresh.diagnostics, embeddings: refresh.diagnostics, index };
        return { content: [{ type: 'text', text: safeJson(payload) }], details: payload, ...payload };
      });
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
        embeddingDimension: embeddingConfig.embeddingDimension,
        embeddingTimeoutMs: embeddingConfig.embeddingTimeoutMs,
        embeddingRequireRemote: Boolean(embeddingConfig.embeddingBaseUrl),
        semanticSearchEnabled: false,
        scannerExcludedExtensions: fileSearchConfig.excludedExtensions,
        scannerBinaryDetectionEnabled: fileSearchConfig.binaryDetectionEnabled,
        scannerIncludeTextFiles: fileSearchConfig.includeTextFiles,
        storageMode: fileSearchConfig.indexStorageMode,
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
