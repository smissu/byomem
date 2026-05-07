import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { MemoryRecord, MemoryScope } from './contracts.js';
import type { NativeStore } from './store.js';
import type { ProjectContext } from './project-context.js';
import { openSqliteSidecar } from './sqlite-sidecar.js';

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
  rawArchiveEnabled?: boolean;
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

export interface ReadOnlyByomemRuntimeContext {
  runtimeBaseDir: string;
  embeddingConfig: ByomemEmbeddingConfig;
  sessionCaptureConfig: ByomemSessionCaptureConfig;
  summarizerConfig: ByomemSummarizerConfig;
  fileSearchConfig: ByomemFileSearchConfig;
  nativeStore: NativeStore;
}

export interface ByomemRuntimeStatusInput {
  runtimeMode: string;
  noPythonDefaultPath: boolean;
  runtimeBaseDir: string;
  nativeStoreBaseDir: string;
  activeProject: ProjectContext;
  embeddingConfig: ByomemEmbeddingConfig;
  sessionCaptureConfig: ByomemSessionCaptureConfig;
  summarizerConfig: ByomemSummarizerConfig;
  fileSearchConfig: ByomemFileSearchConfig;
}

export interface ByomemSearchResultDto {
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
}

export function resolveDefaultRuntimeBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.BYOMEM_RUNTIME_BASE_DIR?.trim();
  return override ? resolve(override) : resolve(homedir(), '.byomem', 'runtime');
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
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
  const quoted = trimmed.match(/^(['\"])([\s\S]*)\1$/)?.[2]?.trim();
  return quoted !== undefined ? quoted : trimmed;
}

function parseYamlListTokens(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(',').map((part) => parseYamlListToken(part)).filter((part): part is string => Boolean(part));
}

function extractYamlBlock(content: string, key: string): string | undefined {
  const match = content.match(new RegExp(`${key}:\\s*([\\s\\S]*?)(?:\\n\\S|$)`));
  return match?.[1] ?? undefined;
}

function parseConfigYaml(content: string): {
  embeddings?: { base_url?: string; model?: string; dimension?: string; request_timeout?: number };
  summarizer?: { base_url?: string; model?: string; fallback_model?: string; max_tokens?: number; ollama_num_ctx?: number };
  session_capture?: { enabled?: boolean; threshold_turns?: number; large_turn_chars?: number; idle_flush_seconds?: number; min_turns?: number; raw_archive_enabled?: boolean };
} {
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
      raw_archive_enabled: parseBool(sessionCaptureBlock.match(/raw_archive_enabled:\s*(.+)/)?.[1]),
    },
  };
}

export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.BYOMEM_CONFIG_PATH ?? resolve(homedir(), '.byomem', 'config.yaml');
}

export function resolveSummarizerConfig(env: NodeJS.ProcessEnv = process.env): ByomemSummarizerConfig {
  const configPath = resolveConfigPath(env);
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

export function resolveSessionCaptureConfig(env: NodeJS.ProcessEnv = process.env): ByomemSessionCaptureConfig {
  const configPath = resolveConfigPath(env);
  if (existsSync(configPath)) {
    const parsed = parseConfigYaml(readFileSync(configPath, 'utf8'));
    return {
      source: 'config',
      configPath,
      enabled: parsed.session_capture?.enabled ?? false,
      thresholdTurns: parsed.session_capture?.threshold_turns,
      largeTurnChars: parsed.session_capture?.large_turn_chars,
      idleFlushSeconds: parsed.session_capture?.idle_flush_seconds,
      minTurns: parsed.session_capture?.min_turns,
      rawArchiveEnabled: parsed.session_capture?.raw_archive_enabled ?? false,
    };
  }
  return { source: 'default', enabled: false, rawArchiveEnabled: false };
}

export function resolveFileSearchConfig(env: NodeJS.ProcessEnv = process.env): ByomemFileSearchConfig {
  const configPath = resolveConfigPath(env);
  const configContent = existsSync(configPath) ? readFileSync(configPath, 'utf8') : undefined;
  const configBlock = configContent ? extractYamlBlock(configContent, 'file_search') : undefined;
  const envExcludedExtensions = env.BYOMEM_FILE_SEARCH_EXCLUDED_EXTENSIONS;
  const envBinaryDetection = env.BYOMEM_FILE_SEARCH_BINARY_DETECTION;
  const envIncludeTextFiles = env.BYOMEM_FILE_SEARCH_INCLUDE_TEXT_FILES;
  const envEmbeddingBatchSize = env.BYOMEM_FILE_SEARCH_EMBEDDING_BATCH_SIZE;
  const envEmbeddingConcurrency = env.BYOMEM_FILE_SEARCH_EMBEDDING_CONCURRENCY;
  const envIndexStorageMode = env.BYOMEM_FILE_SEARCH_INDEX_STORAGE_MODE;
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

export function resolveEmbeddingConfig(env: NodeJS.ProcessEnv = process.env): ByomemEmbeddingConfig {
  const configPath = resolveConfigPath(env);
  const parsed = existsSync(configPath) ? parseConfigYaml(readFileSync(configPath, 'utf8')) : undefined;
  const envBaseUrl = env.BYOMEM_EMBEDDING_BASE_URL;
  const envModel = env.BYOMEM_EMBEDDING_MODEL;
  const envTimeout = env.BYOMEM_EMBEDDING_TIMEOUT_MS;
  const envDimension = env.BYOMEM_EMBEDDING_DIMENSION;
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

export function inferSummarizerTransport(baseUrl: string | undefined): ByomemSummarizerConfig['generationTransport'] {
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

export function openReadOnlyNativeStore(baseDir: string, embeddingConfig: ByomemEmbeddingConfig = { source: 'default' }): NativeStore {
  const resolvedBaseDir = resolve(baseDir);
  const sidecar = openSqliteSidecar({
    baseDir: resolvedBaseDir,
    embeddingBaseUrl: embeddingConfig.embeddingBaseUrl,
    embeddingModel: embeddingConfig.embeddingModel,
    embeddingDimension: embeddingConfig.embeddingDimension,
    embeddingTimeoutMs: embeddingConfig.embeddingTimeoutMs,
    embeddingRequireRemote: Boolean(embeddingConfig.embeddingBaseUrl),
  });
  return {
    baseDir: resolvedBaseDir,
    sidecar,
    async write(): Promise<MemoryRecord> {
      throw new Error('read-only native store does not support write');
    },
    read(id: string): MemoryRecord | undefined {
      return sidecar.read(id);
    },
    list(): MemoryRecord[] {
      return sidecar.list();
    },
    prune(): MemoryRecord | undefined {
      throw new Error('read-only native store does not support prune');
    },
    close(): void {
      sidecar.close();
    },
  };
}

export function openReadOnlyRuntimeContext(options: { env?: NodeJS.ProcessEnv; runtimeBaseDir?: string } = {}): ReadOnlyByomemRuntimeContext {
  const env = options.env ?? process.env;
  const runtimeBaseDir = options.runtimeBaseDir ?? resolveDefaultRuntimeBaseDir(env);
  const embeddingConfig = resolveEmbeddingConfig(env);
  const sessionCaptureConfig = resolveSessionCaptureConfig(env);
  const summarizerConfig = resolveSummarizerConfig(env);
  const fileSearchConfig = resolveFileSearchConfig(env);
  const nativeStore = openReadOnlyNativeStore(runtimeBaseDir, embeddingConfig);
  return { runtimeBaseDir, embeddingConfig, sessionCaptureConfig, summarizerConfig, fileSearchConfig, nativeStore };
}

export function buildByomemRuntimeStatus(input: ByomemRuntimeStatusInput) {
  return {
    runtimeMode: input.runtimeMode,
    pythonDefaultDisabled: true,
    noPythonDefaultPath: input.noPythonDefaultPath,
    packageSurface: 'ts/packages/runtime',
    storeBaseDir: input.runtimeBaseDir,
    nativeStorePath: input.nativeStoreBaseDir,
    memoryDbPath: resolve(input.nativeStoreBaseDir, 'byomem-index.sqlite'),
    activeProject: input.activeProject,
    projectKey: input.activeProject.projectKey,
    embeddingConfigSource: input.embeddingConfig.source,
    embeddingConfigPath: input.embeddingConfig.configPath,
    embeddingBaseUrl: input.embeddingConfig.embeddingBaseUrl,
    embeddingModel: input.embeddingConfig.embeddingModel,
    embeddingDimension: input.embeddingConfig.embeddingDimension,
    embeddingTimeoutMs: input.embeddingConfig.embeddingTimeoutMs,
    embeddingRequireRemote: Boolean(input.embeddingConfig.embeddingBaseUrl),
    fileSearchConfigSource: input.fileSearchConfig.source,
    fileSearchConfigPath: input.fileSearchConfig.configPath,
    fileSearchScannerExcludedExtensions: input.fileSearchConfig.excludedExtensions,
    fileSearchBinaryDetectionEnabled: input.fileSearchConfig.binaryDetectionEnabled,
    fileSearchEmbeddingBatchSize: input.fileSearchConfig.embeddingBatchSize,
    fileSearchEmbeddingConcurrency: input.fileSearchConfig.embeddingConcurrency,
    fileSearchIndexStorageMode: input.fileSearchConfig.indexStorageMode,
    summarizerConfigSource: input.summarizerConfig.source,
    summarizerConfigPath: input.summarizerConfig.configPath,
    summarizerBaseUrl: input.summarizerConfig.generationBaseUrl,
    summarizerModel: input.summarizerConfig.generationModel,
    summarizerFallbackModel: input.summarizerConfig.generationFallbackModel,
    summarizerOllamaNumCtx: input.summarizerConfig.ollamaNumCtx,
    sessionCaptureConfigSource: input.sessionCaptureConfig.source,
    sessionCaptureEnabled: input.sessionCaptureConfig.enabled,
    sessionCaptureThresholdTurns: input.sessionCaptureConfig.thresholdTurns,
    sessionCaptureLargeTurnChars: input.sessionCaptureConfig.largeTurnChars,
    sessionCaptureIdleFlushSeconds: input.sessionCaptureConfig.idleFlushSeconds,
    sessionCaptureMinTurns: input.sessionCaptureConfig.minTurns,
    sessionCaptureRawArchiveEnabled: input.sessionCaptureConfig.rawArchiveEnabled,
  };
}

function redactSensitiveOutput(value: unknown): unknown {
  if (typeof value === 'string') {
    return /["'](?:thinkingSignature|textSignature|encrypted_content|encryptedContent)["']\s*:/.test(value) ? '[REDACTED]' : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactSensitiveOutput(item));
  if (!value || typeof value !== 'object') return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'thinkingSignature' || key === 'textSignature' || key === 'encrypted_content' || key === 'encryptedContent') continue;
    redacted[key] = redactSensitiveOutput(nestedValue);
  }
  return redacted;
}

export function safeJson(value: unknown): string {
  return JSON.stringify(redactSensitiveOutput(value), null, 2);
}

export function shapeByomemSearchResult<T extends {
  id?: unknown;
  scope?: unknown;
  identity?: { namespace?: unknown; leafName?: unknown; parentContext?: unknown };
  content?: { text?: unknown; structured?: Record<string, unknown> };
  provenance?: { source?: unknown };
}>(result: T): ByomemSearchResultDto {
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

export function shapeByomemSearchResults<T extends Parameters<typeof shapeByomemSearchResult>[0]>(results: T[]): ByomemSearchResultDto[] {
  return results.map((result) => shapeByomemSearchResult(result));
}

function parseFileSearchYamlConfig(block: string): { excludedExtensions?: string[]; binaryDetectionEnabled?: boolean; includeTextFiles?: boolean; embeddingBatchSize?: number; embeddingConcurrency?: number; indexStorageMode?: 'disk' | 'memory' } {
  const binaryDetectionEnabled = parseBooleanText(block.match(/binary_detection:\s*([^\n]+)/)?.[1]?.trim(), 'file_search.binary_detection');
  const includeTextFiles = parseBooleanText(block.match(/include_text_files:\s*([^\n]+)/)?.[1]?.trim(), 'file_search.include_text_files');
  const embeddingBatchSize = parsePositiveSafeIntegerConfig(block.match(/embedding_batch_size:\s*([^\n]+)/)?.[1]?.trim(), 'file_search.embedding_batch_size');
  const embeddingConcurrency = parsePositiveSafeIntegerConfig(block.match(/embedding_concurrency:\s*([^\n]+)/)?.[1]?.trim(), 'file_search.embedding_concurrency');
  const indexStorageMode = parseStorageModeText(block.match(/(?:index_storage_mode|storage_mode):\s*([^\n]+)/)?.[1]?.trim(), 'file_search.index_storage_mode');
  const bracketed = block.match(/excluded_extensions:\s*\[([\s\S]*?)\]/)?.[1];
  if (bracketed !== undefined) {
    return {
      excludedExtensions: parseYamlListTokens(bracketed),
      ...(embeddingBatchSize !== undefined ? { embeddingBatchSize } : {}),
      ...(embeddingConcurrency !== undefined ? { embeddingConcurrency } : {}),
      ...(indexStorageMode !== undefined ? { indexStorageMode } : {}),
      ...(binaryDetectionEnabled !== undefined ? { binaryDetectionEnabled } : {}),
      ...(includeTextFiles !== undefined ? { includeTextFiles } : {}),
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
      ...(includeTextFiles !== undefined ? { includeTextFiles } : {}),
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
