#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { inspectNativeStoreConflict, openNativeStore, repairNativeStoreConflict } from './store.js';
import { openFileSearchDb } from './file-search-db.js';
import { openFileSearchRegistryDb } from './file-search-db.js';
import { openGraphDb, type GraphUpdateOptions } from './graph-db.js';
import { buildFileSearchIndex } from './file-search-index.js';
import { enrichFileSearchHitsWithGraph } from './file-search-graph-context.js';
import { listFileSearchProjects, markFileSearchProjectSeen, normalizeFileSearchPollingDisabledReason, registerFileSearchProject, unregisterFileSearchProject } from './file-search-project-registry.js';
import { configureFileSearchPolling, disableFileSearchPolling, getFileSearchPollingStatus } from './file-search-active-poller.js';
import { openQueueRuntime } from './queue-runtime.js';
import { searchIndex } from './search-index.js';
import { buildSearchSemanticMetadata, findRelated as findRelatedFileIndex, searchIndex as searchFileIndex } from './file-search-query.js';
import { refreshSemanticIndexAfterManualScan } from './file-search-semantic-refresh.js';
import { openGenerationClient } from './generation-client.js';
import { observeQueue, renderQueueObserver } from './queue-observer.js';
import { resolveDefaultRuntimeBaseDir } from './readonly-core.js';
import { buildByomemStatusReport } from './status-report.js';
import { buildProcessCleanupReport } from './process-cleanup.js';
import { runCodexSessionCaptureCommand } from './codex-session-capture.js';

const GENERATION_COMMANDS = new Set(['generate', 'summarize', 'reason', 'chat']);
const OBSERVER_COMMANDS = new Set(['queue-observe']);
const OBSERVER_WATCH_INTERVAL_DEFAULT = 2;
const OBSERVER_WATCH_INTERVAL_MIN = 0.1;

type CliOptions = {
  baseDir: string;
  embeddingBaseUrl?: string;
  embeddingModel?: string;
  embeddingDimension?: number;
  embeddingTimeoutMs?: number;
  embeddingRequireRemote?: boolean;
  fileSearchEmbeddingBatchSize?: number;
  fileSearchEmbeddingConcurrency?: number;
  fileSearchSemanticEnabled?: boolean;
  fileSearchScannerExcludedExtensions?: string[];
  fileSearchBinaryDetectionEnabled?: boolean;
  fileSearchIncludeTextFiles?: boolean;
  fileSearchIndexStorageMode?: 'disk' | 'memory';
  generationBaseUrl?: string;
  generationModel?: string;
  generationTimeoutMs?: number;
  generationSystem?: string;
  generationMessages?: string;
};

type ObserverWatchMode = { enabled: boolean; intervalSeconds: number };
type NativeStoreRepairAuthority = 'sqlite' | 'json' | 'abort';

function usage(): { error: string; commands: string[] } {
  return { error: 'Usage', commands: ['store', 'search', 'codex-session-capture', 'file-search', 'file-search-related', 'file-search-scan', 'file-search-status', 'file-search-semantic-refresh', 'file-search-polling-status', 'file-search-polling-enable', 'file-search-polling-disable', 'file-search-project-register', 'file-search-project-unregister', 'file-search-project-list', 'graph-status', 'graph-query', 'graph-explain', 'graph-path', 'graph-update', 'native-store-inspect', 'native-store-repair', 'prune', 'queue-observe', 'status', 'cleanup', 'stop', 'generate', 'summarize', 'reason', 'chat'] };
}

function jsonError(message: string, command: string | null): void {
  console.error(JSON.stringify({ error: message, usage: usage(), command }));
}

function requireValue(value: string | undefined, flag: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`Missing value for ${flag}`);
  return trimmed;
}

function parseMessages(raw: string | undefined): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> | undefined {
  if (!raw) return undefined;
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error('--messages must be a JSON array');
  return (parsed as Array<unknown>).map((item) => {
    if (!item || typeof item !== 'object') throw new Error('--messages items must be objects');
    const message = item as { role?: string; content?: unknown };
    if (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant') throw new Error('--messages roles must be system, user, or assistant');
    if (typeof message.content !== 'string' || !message.content.trim()) throw new Error('--messages content must be a non-empty string');
    return { role: message.role as 'system' | 'user' | 'assistant', content: message.content };
  });
}

function parseWatchMode(flags: { watch: boolean; watchInterval?: string }, json: boolean): ObserverWatchMode {
  if (!flags.watch) return { enabled: false, intervalSeconds: OBSERVER_WATCH_INTERVAL_DEFAULT };
  const intervalRaw = flags.watchInterval?.trim() || String(OBSERVER_WATCH_INTERVAL_DEFAULT);
  const intervalSeconds = Number(intervalRaw);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < OBSERVER_WATCH_INTERVAL_MIN) throw new Error('--watch-interval must be a positive number');
  if (json) throw new Error('--watch is not supported with --json in queue-observe');
  return { enabled: true, intervalSeconds };
}

type FileSearchCliRequest = { query: string; mode: 'bm25' | 'semantic' | 'hybrid'; limit: number; includeGraph?: boolean };
type MemorySearchCliRequest = { query: string; mode: 'bm25' | 'semantic' | 'hybrid'; limit: number; scope?: 'project' | 'dir' | 'user' | 'agent' };
type FileSearchRelatedCliRequest = { filePath: string; line: number; limit: number };
type GraphCliRequest = { query: string; limit: number };
type GraphPathCliRequest = { source: string; target: string; maxDepth: number };
type DirectFileSearchCliStore = {
  baseDir: string;
  fileSearchDb: ReturnType<typeof openFileSearchDb>;
  fileSearchProjectBaseDir: string;
  close(): void;
};

type CliFileSearchProject = {
  project_key: string;
  base_dir: string;
  display_name: string;
  state: ReturnType<typeof registerFileSearchProject>['state'];
  source: ReturnType<typeof registerFileSearchProject>['source'];
  poll_interval_seconds?: number;
  polling_enabled: boolean;
  last_poll_at?: string;
  next_poll_at?: string;
  consecutive_no_change_polls: number;
  idle_disable_after_polls?: number;
  polling_disabled_reason?: string;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
  registered_at?: string;
  last_scan_at?: string;
  last_error?: string;
};

function serializeFileSearchProject(project: ReturnType<typeof registerFileSearchProject>): CliFileSearchProject {
  return {
    project_key: project.projectKey,
    base_dir: project.baseDir,
    display_name: project.displayName,
    state: project.state,
    source: project.source,
    poll_interval_seconds: project.pollIntervalSeconds,
    polling_enabled: project.pollingEnabled,
    last_poll_at: project.lastPollAt,
    next_poll_at: project.nextPollAt,
    consecutive_no_change_polls: project.consecutiveNoChangePolls,
    idle_disable_after_polls: project.idleDisableAfterPolls,
    polling_disabled_reason: project.pollingDisabledReason,
    created_at: project.createdAt,
    updated_at: project.updatedAt,
    last_seen_at: project.lastSeenAt,
    registered_at: project.registeredAt,
    last_scan_at: project.lastScanAt,
    last_error: project.lastError,
  };
}

function openDirectFileSearchCliStore(options: CliOptions): DirectFileSearchCliStore {
  const baseDir = resolve(options.baseDir);
  const fileSearchDb = openFileSearchDb({
    baseDir,
    projectBaseDir: baseDir,
    embeddingBaseUrl: options.embeddingBaseUrl,
    embeddingModel: options.embeddingModel,
    embeddingDimension: options.embeddingDimension,
    embeddingTimeoutMs: options.embeddingTimeoutMs,
    embeddingRequireRemote: options.embeddingRequireRemote,
    semanticSearchEnabled: options.fileSearchSemanticEnabled,
    embeddingBatchSize: options.fileSearchEmbeddingBatchSize,
    embeddingConcurrency: options.fileSearchEmbeddingConcurrency,
    scanOnOpen: false,
    schedulerEnabled: false,
    scannerExcludedExtensions: options.fileSearchScannerExcludedExtensions,
    scannerBinaryDetectionEnabled: options.fileSearchBinaryDetectionEnabled,
    scannerIncludeTextFiles: options.fileSearchIncludeTextFiles,
    storageMode: options.fileSearchIndexStorageMode,
  });
  return {
    baseDir,
    fileSearchDb,
    fileSearchProjectBaseDir: baseDir,
    close(): void {
      fileSearchDb.close();
    },
  };
}

function parseArgs(argv: string[]): { command?: string; options: CliOptions; payload: Record<string, string>; flags: { watch: boolean; watchInterval?: string; baseDirProvided: boolean; dryRun: boolean; apply: boolean } } {
  const payload: Record<string, string> = {};
  const flags = { watch: false, watchInterval: undefined as string | undefined, baseDirProvided: false, dryRun: false, apply: false };
  const options: CliOptions = {
    baseDir: resolve(tmpdir(), `byomem-cli-${randomUUID()}`),
    fileSearchScannerExcludedExtensions: parseExtensionList(process.env.BYOMEM_FILE_SEARCH_EXCLUDED_EXTENSIONS),
    fileSearchBinaryDetectionEnabled: parseBooleanFlag(process.env.BYOMEM_FILE_SEARCH_BINARY_DETECTION, 'BYOMEM_FILE_SEARCH_BINARY_DETECTION'),
    fileSearchIncludeTextFiles: parseBooleanFlag(process.env.BYOMEM_FILE_SEARCH_INCLUDE_TEXT_FILES, 'BYOMEM_FILE_SEARCH_INCLUDE_TEXT_FILES'),
    fileSearchIndexStorageMode: parseStorageMode(process.env.BYOMEM_FILE_SEARCH_INDEX_STORAGE_MODE, 'BYOMEM_FILE_SEARCH_INDEX_STORAGE_MODE'),
    fileSearchEmbeddingBatchSize: (() => {
      const raw = process.env.BYOMEM_FILE_SEARCH_EMBEDDING_BATCH_SIZE?.trim();
      if (raw === undefined || raw === '') return undefined;
      if (!/^[1-9]\d*$/.test(raw)) throw new Error('BYOMEM_FILE_SEARCH_EMBEDDING_BATCH_SIZE must be a positive integer');
      const value = Number(raw);
      if (!Number.isSafeInteger(value)) throw new Error('BYOMEM_FILE_SEARCH_EMBEDDING_BATCH_SIZE must be a positive integer');
      return value;
    })(),
    fileSearchEmbeddingConcurrency: (() => {
      const raw = process.env.BYOMEM_FILE_SEARCH_EMBEDDING_CONCURRENCY?.trim();
      if (raw === undefined || raw === '') return undefined;
      if (!/^[1-9]\d*$/.test(raw)) throw new Error('BYOMEM_FILE_SEARCH_EMBEDDING_CONCURRENCY must be a positive integer');
      const value = Number(raw);
      if (!Number.isSafeInteger(value)) throw new Error('BYOMEM_FILE_SEARCH_EMBEDDING_CONCURRENCY must be a positive integer');
      return value;
    })(),
  };
  let command: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (!command && !arg.startsWith('--')) { command = arg; continue; }
    if (arg === '--help' || arg === '-h') return { command: 'help', options, payload, flags };
    if (arg === '--base-dir') { options.baseDir = requireValue(next, '--base-dir'); flags.baseDirProvided = true; i += 1; }
    else if (arg === '--embedding-base-url') { options.embeddingBaseUrl = requireValue(next, '--embedding-base-url'); i += 1; }
    else if (arg === '--embedding-model') { options.embeddingModel = requireValue(next, '--embedding-model'); i += 1; }
    else if (arg === '--embedding-dimension') { const raw = requireValue(next, '--embedding-dimension'); if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error('--embedding-dimension must be a positive integer'); options.embeddingDimension = Number(raw); i += 1; }
    else if (arg === '--embedding-timeout-ms') { options.embeddingTimeoutMs = Number(requireValue(next, '--embedding-timeout-ms')); i += 1; }
    else if (arg === '--embedding-require-remote') { options.embeddingRequireRemote = true; }
    else if (arg === '--generation-base-url') { options.generationBaseUrl = requireValue(next, '--generation-base-url'); i += 1; }
    else if (arg === '--generation-model') { options.generationModel = requireValue(next, '--generation-model'); i += 1; }
    else if (arg === '--generation-timeout-ms') { options.generationTimeoutMs = Number(requireValue(next, '--generation-timeout-ms')); i += 1; }
    else if (arg === '--generation-system') { options.generationSystem = requireValue(next, '--generation-system'); i += 1; }
    else if (arg === '--messages') { options.generationMessages = requireValue(next, '--messages'); i += 1; }
    else if (arg === '--input') { payload.input = requireValue(next, '--input'); i += 1; }
    else if (arg === '--json') { payload.json = 'true'; }
    else if (arg === '--async') { payload.async = 'true'; }
    else if (arg === '--watch') { flags.watch = true; }
    else if (arg === '--watch-interval') { flags.watchInterval = requireValue(next, '--watch-interval'); i += 1; }
    else if (arg === '--dry-run') { flags.dryRun = true; }
    else if (arg === '--apply') { flags.apply = true; }
    else if (arg === '--poll-interval-seconds') { payload.pollIntervalSeconds = requireValue(next, '--poll-interval-seconds'); i += 1; }
    else if (arg === '--idle-disable-after-polls') { payload.idleDisableAfterPolls = requireValue(next, '--idle-disable-after-polls'); i += 1; }
    else if (arg === '--reason') { payload.reason = requireValue(next, '--reason'); i += 1; }
    else if (arg === '--history') { payload.history = requireValue(next, '--history'); i += 1; }
    else if (arg === '--query') { payload.query = requireValue(next, '--query'); i += 1; }
    else if (arg === '--id') { payload.id = requireValue(next, '--id'); i += 1; }
    else if (arg === '--scope') { payload.scope = requireValue(next, '--scope'); i += 1; }
    else if (arg === '--mode') { payload.mode = requireValue(next, '--mode'); i += 1; }
    else if (arg === '--limit') { payload.limit = requireValue(next, '--limit'); i += 1; }
    else if (arg === '--authority') { payload.authority = requireValue(next, '--authority'); i += 1; }
    else if (arg === '--file-path') { payload.filePath = requireValue(next, '--file-path'); i += 1; }
    else if (arg === '--line') { payload.line = requireValue(next, '--line'); i += 1; }
    else if (arg === '--source') { payload.source = requireValue(next, '--source'); i += 1; }
    else if (arg === '--target') { payload.target = requireValue(next, '--target'); i += 1; }
    else if (arg === '--max-depth') { payload.maxDepth = requireValue(next, '--max-depth'); i += 1; }
    else if (arg === '--graph-json') { payload.graphJsonPath = requireValue(next, '--graph-json'); i += 1; }
    else if (arg === '--report') { payload.reportPath = requireValue(next, '--report'); i += 1; }
    else if (arg === '--graph-mode') { payload.graphMode = requireValue(next, '--graph-mode'); i += 1; }
    else if (arg === '--allow-native-downgrade') { payload.allowNativeDowngrade = 'true'; }
    else if (arg === '--include-graph') { payload.includeGraph = 'true'; }
    else if (arg === '--semantic-file-search') { options.fileSearchSemanticEnabled = true; }
    else if (arg === '--file-search-excluded-extensions') { if (next === undefined) throw new Error('Missing value for --file-search-excluded-extensions'); options.fileSearchScannerExcludedExtensions = parseExtensionList(next); i += 1; }
    else if (arg === '--file-search-include-text-files') { options.fileSearchIncludeTextFiles = parseBooleanFlag(requireValue(next, '--file-search-include-text-files'), '--file-search-include-text-files'); i += 1; }
    else if (arg === '--file-search-binary-detection') { options.fileSearchBinaryDetectionEnabled = parseBooleanFlag(requireValue(next, '--file-search-binary-detection'), '--file-search-binary-detection'); i += 1; }
    else if (arg === '--file-search-index-storage-mode') { options.fileSearchIndexStorageMode = parseStorageMode(requireValue(next, '--file-search-index-storage-mode'), '--file-search-index-storage-mode'); i += 1; }
    else if (arg === '--file-search-embedding-batch-size') {
      const raw = requireValue(next, '--file-search-embedding-batch-size');
      if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error('--file-search-embedding-batch-size must be a positive integer');
      options.fileSearchEmbeddingBatchSize = Number(raw);
      i += 1;
    }
    else if (arg === '--file-search-embedding-concurrency') {
      const raw = requireValue(next, '--file-search-embedding-concurrency');
      if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error('--file-search-embedding-concurrency must be a positive integer');
      options.fileSearchEmbeddingConcurrency = Number(raw);
      i += 1;
    }
    else if (arg === '--prompt') { payload.prompt = requireValue(next, '--prompt'); i += 1; }
    else if (arg === '--text') { payload.text = requireValue(next, '--text'); i += 1; }
  }
  return { command, options, payload, flags };
}

function parsePositiveIntegerFlag(payload: Record<string, string>, key: string, flag: string): number {
  const raw = payload[key]?.trim();
  if (!raw || !/^[1-9]\d*$/.test(raw)) throw new Error(`${flag} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${flag} must be a positive integer`);
  return value;
}

function parseBooleanFlag(value: string | undefined, flag: string): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${flag} must be true or false`);
}

function parseStorageMode(value: string | undefined, flag: string): 'disk' | 'memory' | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'disk' || normalized === 'memory') return normalized;
  throw new Error(`${flag} must be disk or memory`);
}

function parseExtensionList(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(',').map((part) => part.trim()).filter(Boolean);
}

function parseOptionalPositiveIntegerFlag(payload: Record<string, string>, key: string, flag: string): number | undefined {
  return payload[key] === undefined ? undefined : parsePositiveIntegerFlag(payload, key, flag);
}

function parseNativeStoreRepairAuthority(value: string | undefined): NativeStoreRepairAuthority {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'sqlite' || normalized === 'json' || normalized === 'abort') return normalized;
  throw new Error('Missing --authority for native-store-repair');
}

function parseFileSearchRequest(payload: Record<string, string>): FileSearchCliRequest {
  const query = payload.query?.trim();
  if (!query) throw new Error('Missing --query for file-search');
  const mode = (payload.mode?.trim() || 'hybrid') as 'bm25' | 'semantic' | 'hybrid';
  if (mode !== 'bm25' && mode !== 'semantic' && mode !== 'hybrid') throw new Error('--mode must be bm25, semantic, or hybrid');
  const limitRaw = payload.limit?.trim() || '10';
  if (!/^[1-9]\d*$/.test(limitRaw)) throw new Error('--limit must be a positive integer');
  const limit = Number(limitRaw);
  if (!Number.isSafeInteger(limit)) throw new Error('--limit must be a positive integer');
  return { query, mode, limit, ...(payload.includeGraph === 'true' ? { includeGraph: true } : {}) };
}

function parseMemorySearchRequest(payload: Record<string, string>): MemorySearchCliRequest {
  const query = payload.query?.trim();
  if (!query) throw new Error('Missing --query for search');
  const mode = (payload.mode?.trim() || 'hybrid') as 'bm25' | 'semantic' | 'hybrid';
  if (mode !== 'bm25' && mode !== 'semantic' && mode !== 'hybrid') throw new Error('--mode must be bm25, semantic, or hybrid');
  const limitRaw = payload.limit?.trim() || '10';
  if (!/^[1-9]\d*$/.test(limitRaw)) throw new Error('--limit must be a positive integer');
  const limit = Number(limitRaw);
  if (!Number.isSafeInteger(limit)) throw new Error('--limit must be a positive integer');
  const rawScope = payload.scope?.trim();
  const scope = rawScope === undefined || rawScope === '' ? undefined : rawScope;
  if (scope !== undefined && scope !== 'project' && scope !== 'dir' && scope !== 'user' && scope !== 'agent') throw new Error('--scope must be project, dir, user, or agent');
  return { query, mode, limit, ...(scope ? { scope } : {}) };
}

function parseFileSearchRelatedRequest(payload: Record<string, string>): FileSearchRelatedCliRequest {
  const filePath = payload.filePath?.trim();
  if (!filePath) throw new Error('Missing --file-path for file-search-related');
  const lineRaw = payload.line?.trim();
  if (!lineRaw || !/^[1-9]\d*$/.test(lineRaw)) throw new Error('--line must be a positive integer');
  const line = Number(lineRaw);
  if (!Number.isSafeInteger(line)) throw new Error('--line must be a positive integer');
  const limitRaw = payload.limit?.trim() || '5';
  if (!/^[1-9]\d*$/.test(limitRaw)) throw new Error('--limit must be a positive integer');
  const limit = Number(limitRaw);
  if (!Number.isSafeInteger(limit)) throw new Error('--limit must be a positive integer');
  return { filePath, line, limit };
}

function parseGraphRequest(payload: Record<string, string>, command: string): GraphCliRequest {
  const query = payload.query?.trim();
  if (!query) throw new Error(`Missing --query for ${command}`);
  const limitRaw = payload.limit?.trim() || '10';
  if (!/^[1-9]\d*$/.test(limitRaw)) throw new Error('--limit must be a positive integer');
  const limit = Number(limitRaw);
  if (!Number.isSafeInteger(limit)) throw new Error('--limit must be a positive integer');
  return { query, limit };
}

function parseGraphPathRequest(payload: Record<string, string>): GraphPathCliRequest {
  const source = payload.source?.trim();
  const target = payload.target?.trim();
  if (!source) throw new Error('Missing --source for graph-path');
  if (!target) throw new Error('Missing --target for graph-path');
  const depthRaw = payload.maxDepth?.trim() || '4';
  if (!/^[1-9]\d*$/.test(depthRaw)) throw new Error('--max-depth must be a positive integer');
  const maxDepth = Number(depthRaw);
  if (!Number.isSafeInteger(maxDepth)) throw new Error('--max-depth must be a positive integer');
  return { source, target, maxDepth };
}

function parseGraphUpdateOptions(payload: Record<string, string>, baseDir: string): GraphUpdateOptions {
  const graphMode = payload.graphMode?.trim();
  if (graphMode !== undefined && graphMode !== 'auto' && graphMode !== 'graphify-export' && graphMode !== 'native-source') throw new Error('--graph-mode must be auto, graphify-export, or native-source');
  return {
    baseDir,
    graphJsonPath: payload.graphJsonPath?.trim(),
    reportPath: payload.reportPath?.trim(),
    mode: graphMode,
    allowNativeDowngrade: payload.allowNativeDowngrade === 'true',
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    const command = argv.find((arg) => !arg.startsWith('--')) ?? null;
    jsonError(error instanceof Error ? error.message : String(error), command);
    process.exitCode = 1;
    return;
  }
  const { command, options, payload, flags } = parsed;
  if (!command) {
    jsonError('Missing command', null);
    process.exitCode = 1;
    return;
  }
  if (command === 'help') {
    console.log(JSON.stringify(usage(), null, 2));
    return;
  }

  if (command === 'status') {
    console.log(JSON.stringify(buildByomemStatusReport({
      env: process.env,
      cwd: process.cwd(),
      projectBaseDir: flags.baseDirProvided ? options.baseDir : undefined,
      runtimeBaseDir: flags.baseDirProvided ? options.baseDir : undefined,
    }), null, 2));
    return;
  }
  if (command === 'cleanup' || command === 'stop') {
    if (flags.apply) {
      jsonError(`${command} apply mode is not implemented; rerun without --apply for dry-run`, command);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(buildProcessCleanupReport({
      command,
      runtimeBaseDir: flags.baseDirProvided ? options.baseDir : resolveDefaultRuntimeBaseDir(process.env),
    }), null, 2));
    return;
  }

  const isGenerationCommand = GENERATION_COMMANDS.has(command);
  const isObserverCommand = OBSERVER_COMMANDS.has(command);
  const isFileSearchCommand = command === 'file-search' || command === 'file-search-related' || command === 'file-search-scan' || command === 'file-search-status' || command === 'file-search-semantic-refresh';
  const isFileSearchPollingCommand = command === 'file-search-polling-status' || command === 'file-search-polling-enable' || command === 'file-search-polling-disable';
  const isFileSearchRegistryCommand = command === 'file-search-project-register' || command === 'file-search-project-unregister' || command === 'file-search-project-list';
  const isGraphCommand = command === 'graph-status' || command === 'graph-query' || command === 'graph-explain' || command === 'graph-path' || command === 'graph-update';
  const isNativeStoreConflictCommand = command === 'native-store-inspect' || command === 'native-store-repair';
  const isFileSearchScanCommand = command === 'file-search-scan';
  const isFileSearchStatusCommand = command === 'file-search-status';
  const isFileSearchSemanticRefreshCommand = command === 'file-search-semantic-refresh';
  let store: ReturnType<typeof openNativeStore> | undefined;
  let fileSearchStore: DirectFileSearchCliStore | undefined;
  let graphStore: ReturnType<typeof openGraphDb> | undefined;
  let queueRuntime: ReturnType<typeof openQueueRuntime> | undefined;
  let memorySearchRequest: MemorySearchCliRequest | undefined;
  let fileSearchRequest: FileSearchCliRequest | undefined;
  let fileSearchRelatedRequest: FileSearchRelatedCliRequest | undefined;
  let graphRequest: GraphCliRequest | undefined;
  let graphPathRequest: GraphPathCliRequest | undefined;
  try {
    memorySearchRequest = command === 'search' ? parseMemorySearchRequest(payload) : undefined;
    fileSearchRequest = command === 'file-search' ? parseFileSearchRequest(payload) : undefined;
    fileSearchRelatedRequest = command === 'file-search-related' ? parseFileSearchRelatedRequest(payload) : undefined;
    graphRequest = command === 'graph-query' || command === 'graph-explain' ? parseGraphRequest(payload, command) : undefined;
    graphPathRequest = command === 'graph-path' ? parseGraphPathRequest(payload) : undefined;
    if (isNativeStoreConflictCommand) {
      if (command === 'native-store-inspect') {
        console.log(JSON.stringify({ inspection: inspectNativeStoreConflict(options) }, null, 2));
        return;
      }
      const authority = parseNativeStoreRepairAuthority(payload.authority);
      console.log(JSON.stringify({ repair: repairNativeStoreConflict({ ...options, authority, dryRun: flags.dryRun }) }, null, 2));
      return;
    }
    if (command === 'codex-session-capture') {
      const result = await runCodexSessionCaptureCommand({
        input: payload.input,
        runtimeBaseDir: flags.baseDirProvided ? options.baseDir : undefined,
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (isFileSearchPollingCommand) {
      if (!flags.baseDirProvided) throw new Error(`Missing --base-dir for ${command}`);
      if (command === 'file-search-polling-status') {
        const polling = getFileSearchPollingStatus(options.baseDir);
        console.log(JSON.stringify({ polling, status: polling }, null, 2));
        return;
      }
      if (command === 'file-search-polling-enable') {
        const pollIntervalSeconds = parsePositiveIntegerFlag(payload, 'pollIntervalSeconds', '--poll-interval-seconds');
        const idleDisableAfterPolls = parseOptionalPositiveIntegerFlag(payload, 'idleDisableAfterPolls', '--idle-disable-after-polls');
        const polling = configureFileSearchPolling(options.baseDir, { pollIntervalSeconds, idleDisableAfterPolls });
        console.log(JSON.stringify({ polling, status: polling }, null, 2));
        return;
      }
      const reason = normalizeFileSearchPollingDisabledReason(payload.reason?.trim() || 'manually-disabled');
      const polling = disableFileSearchPolling(options.baseDir, reason);
      console.log(JSON.stringify({ polling, status: polling }, null, 2));
      return;
    }
    if (isFileSearchRegistryCommand) {
      if ((command === 'file-search-project-register' || command === 'file-search-project-unregister') && !flags.baseDirProvided) {
        throw new Error(`Missing --base-dir for ${command}`);
      }
      const registryDb = openFileSearchRegistryDb();
      try {
        if (command === 'file-search-project-register') {
          console.log(JSON.stringify({ project: serializeFileSearchProject(registerFileSearchProject(registryDb.db, options.baseDir)) }, null, 2));
          return;
        }
        if (command === 'file-search-project-unregister') {
          console.log(JSON.stringify({ project: serializeFileSearchProject(unregisterFileSearchProject(registryDb.db, options.baseDir)) }, null, 2));
          return;
        }
        console.log(JSON.stringify({ projects: listFileSearchProjects(registryDb.db).map(serializeFileSearchProject) }, null, 2));
        return;
      } finally {
        registryDb.close();
      }
    }
    if (command === 'file-search-scan' && payload.async === 'true') {
      throw new Error('async-scan-runtime-local-only: file-search-scan --async requires an active runtime worker and is unsupported by the CLI in Sprint 43');
    }

    if (isFileSearchCommand) {
      fileSearchStore = openDirectFileSearchCliStore(options);
    } else if (isGraphCommand) {
      graphStore = openGraphDb({ baseDir: options.baseDir });
    } else if (!isGenerationCommand && !isObserverCommand) {
      store = openNativeStore({
        ...options,
        embeddingRequireRemote: true,
      });
    }
    queueRuntime = store ? openQueueRuntime(store, { baseDir: options.baseDir }) : undefined;
    if (command === 'store') {
      if (!store) throw new Error('Missing native store');
      if (!payload.input) throw new Error('Missing --input for store');
      if (!queueRuntime) throw new Error('Missing queue runtime');
      const intent = JSON.parse(payload.input) as Parameters<typeof queueRuntime.write>[0];
      console.log(JSON.stringify({ record: await queueRuntime.write(intent) }, null, 2));
      return;
    }
    if (command === 'search') {
      if (!store) throw new Error('Missing native store');
      if (!memorySearchRequest) throw new Error('Missing search request');
      console.log(JSON.stringify({ results: await searchIndex(store, memorySearchRequest) }, null, 2));
      return;
    }

    if (command === 'file-search-semantic-refresh') {
      if (!flags.baseDirProvided) throw new Error('Missing --base-dir for file-search-semantic-refresh');
      if (!fileSearchStore?.fileSearchDb) throw new Error('Missing file-search DB');
      const limit = parseOptionalPositiveIntegerFlag(payload, 'limit', '--limit');
      const diagnostics = await fileSearchStore.fileSearchDb.refreshSemanticIndex({ limit });
      const refresh = { command: 'file-search-semantic-refresh', baseDir: diagnostics.baseDir, projectKey: diagnostics.projectKey, limit };
      const index = buildFileSearchIndex(fileSearchStore as never).stats();
      console.log(JSON.stringify({ refresh, diagnostics, embeddings: diagnostics, index }, null, 2));
      return;
    }
    if (command === 'file-search-status') {
      if (!fileSearchStore) throw new Error('Missing file-search DB');
      const scanner = fileSearchStore.fileSearchDb.getScannerStatus();
      const index = buildFileSearchIndex(fileSearchStore as never).stats();
      console.log(JSON.stringify({ scanner, status: scanner, index }, null, 2));
      return;
    }
    if (command === 'file-search-scan') {
      if (!fileSearchStore) throw new Error('Missing file-search DB');
      fileSearchStore.fileSearchDb.scanAndIndex();
      const refreshLimit = parseOptionalPositiveIntegerFlag(payload, 'limit', '--limit');
      const refresh = await refreshSemanticIndexAfterManualScan(fileSearchStore.fileSearchDb, {
        limit: refreshLimit,
        concurrency: options.fileSearchEmbeddingConcurrency,
      });
      const index = buildFileSearchIndex(fileSearchStore as never).stats();
      const scanner = fileSearchStore.fileSearchDb.getScannerStatus();
      console.log(JSON.stringify({ scanner, status: scanner, refresh, diagnostics: refresh.diagnostics, embeddings: refresh.diagnostics, index }, null, 2));
      return;
    }
    if (command === 'file-search') {
      if (!fileSearchStore) throw new Error('Missing file-search DB');
      if (!fileSearchRequest) throw new Error('Missing file-search request');
      const { query, mode, limit } = fileSearchRequest;
      const request = { query, mode, limit };
      const results = fileSearchRequest.includeGraph
        ? await enrichFileSearchHitsWithGraph(await searchFileIndex(fileSearchStore as never, request), { baseDir: options.baseDir })
        : await searchFileIndex(fileSearchStore as never, request);
      const semantic = await buildSearchSemanticMetadata(fileSearchStore as never, request, results);
      const index = buildFileSearchIndex(fileSearchStore as never).stats();
      console.log(JSON.stringify({ results, ...(semantic ? { semantic } : {}), index }, null, 2));
      return;
    }
    if (command === 'file-search-related') {
      if (!fileSearchStore) throw new Error('Missing file-search DB');
      if (!fileSearchRelatedRequest) throw new Error('Missing file-search-related request');
      const results = await findRelatedFileIndex(fileSearchStore as never, {
        filePath: fileSearchRelatedRequest.filePath,
        line: fileSearchRelatedRequest.line,
        limit: fileSearchRelatedRequest.limit,
      });
      console.log(JSON.stringify({ results }, null, 2));
      return;
    }
    if (command === 'graph-status') {
      if (!graphStore) throw new Error('Missing graph DB');
      console.log(JSON.stringify({ status: graphStore.status() }, null, 2));
      return;
    }
    if (command === 'graph-update') {
      if (!graphStore) throw new Error('Missing graph DB');
      const update = graphStore.update(parseGraphUpdateOptions(payload, options.baseDir));
      console.log(JSON.stringify({ update, status: graphStore.status() }, null, 2));
      return;
    }
    if (command === 'graph-query') {
      if (!graphStore) throw new Error('Missing graph DB');
      if (!graphRequest) throw new Error('Missing graph-query request');
      console.log(JSON.stringify(graphStore.query(graphRequest), null, 2));
      return;
    }
    if (command === 'graph-explain') {
      if (!graphStore) throw new Error('Missing graph DB');
      if (!graphRequest) throw new Error('Missing graph-explain request');
      console.log(JSON.stringify(graphStore.explain(graphRequest), null, 2));
      return;
    }
    if (command === 'graph-path') {
      if (!graphStore) throw new Error('Missing graph DB');
      if (!graphPathRequest) throw new Error('Missing graph-path request');
      console.log(JSON.stringify(graphStore.pathQuery(graphPathRequest), null, 2));
      return;
    }
    if (command === 'prune') {
      if (!store) throw new Error('Missing native store');
      const id = payload.id?.trim();
      if (!id) throw new Error('Missing --id for prune');
      const removed = store.prune(id) ?? null;
      console.log(JSON.stringify({ id, deleted: Boolean(removed), removed }, null, 2));
      return;
    }
    if (isObserverCommand) {
      const history = Number(payload.history?.trim() || '5');
      const snapshot = observeQueue({ baseDir: options.baseDir, history, json: Boolean(payload.json) });
      const watchMode = parseWatchMode(flags, Boolean(payload.json));
      if (watchMode.enabled) {
        let shutdown = false;
        let resolveSleep: (() => void) | undefined;
        const render = () => {
          const nextSnapshot = observeQueue({ baseDir: options.baseDir, history, json: false });
          process.stdout.write('\u001b[2J\u001b[H');
          process.stdout.write(`${renderQueueObserver(nextSnapshot)}\n`);
        };
        const stop = () => {
          if (shutdown) return;
          shutdown = true;
          resolveSleep?.();
        };
        const onSigint = () => stop();
        process.once('SIGINT', onSigint);
        try {
          while (!shutdown) {
            render();
            await new Promise<void>((resolve) => {
              resolveSleep = resolve;
              setTimeout(() => {
                resolveSleep = undefined;
                resolve();
              }, watchMode.intervalSeconds * 1000);
              if (shutdown) {
                resolveSleep = undefined;
                resolve();
              }
            });
          }
        } finally {
          process.removeListener('SIGINT', onSigint);
          process.stdout.write('\n');
        }
        return;
      }
      if (payload.json) console.log(JSON.stringify(snapshot, null, 2));
      else console.log(renderQueueObserver(snapshot));
      return;
    }
    if (GENERATION_COMMANDS.has(command)) {
      const client = openGenerationClient({ baseUrl: options.generationBaseUrl, model: options.generationModel, timeoutMs: options.generationTimeoutMs });
      const promptText = payload.prompt?.trim() || payload.text?.trim() || '';
      const messages = parseMessages(options.generationMessages);
      if (!promptText && !messages?.length) throw new Error(`Missing --prompt, --text, or --messages for ${command}`);
      const system = options.generationSystem ?? (command === 'summarize' ? 'Summarize the input concisely.' : command === 'reason' ? 'Reason carefully about the input and answer clearly.' : command === 'chat' ? 'Respond like a helpful assistant.' : undefined);
      const resolvedPrompt = promptText || messages?.at(-1)?.content || '';
      const result = await client.generate({ prompt: resolvedPrompt, system, messages: messages ?? (command === 'chat' ? [{ role: 'user', content: resolvedPrompt }] : undefined) });
      console.log(JSON.stringify({ result }, null, 2));
      return;
    }
    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    jsonError(error instanceof Error ? error.message : String(error), command);
    process.exitCode = 1;
  } finally {
    store?.close();
    fileSearchStore?.close();
    graphStore?.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    jsonError(error instanceof Error ? error.message : String(error), null);
    process.exitCode = 1;
  });
}
