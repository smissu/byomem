import { type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolve } from 'node:path';
import * as z from 'zod/v3';
import { openFileSearchDb, openFileSearchRegistryDb } from '../file-search-db.js';
import { configureFileSearchPolling, disableFileSearchPolling, getFileSearchPollingStatus } from '../file-search-active-poller.js';
import { listFileSearchProjects, registerFileSearchProject, unregisterFileSearchProject, type FileSearchPollingDisabledReason, type FileSearchProjectEntry } from '../file-search-project-registry.js';
import { resolveActiveProjectContext, normalizeStableKey } from '../identity.js';
import { buildSearchSemanticMetadata, redactSensitiveFileSearchText, searchIndex as searchFileIndexForTool } from '../file-search-query.js';
import { safeJson } from '../readonly-core.js';
import type { ReadOnlyMcpRuntimeContext } from './readonly-tools.js';

type MemoryScope = 'project' | 'dir' | 'user' | 'agent';

type MemoryIdentityInput = {
  namespace: string;
  leafName: string;
  parentContext?: string;
};

type StoreIntentInput = {
  scope: MemoryScope;
  identity: MemoryIdentityInput;
  content: {
    text?: string;
    structured?: Record<string, unknown>;
  };
  provenance?: {
    source: string;
    timestamp?: string;
    adapter?: string;
    origin?: string;
  };
};

type PruneIntentInput = {
  scope: MemoryScope;
  identity?: MemoryIdentityInput;
  id?: string;
};

type RefreshIntentInput = {
  baseDir?: string;
  limit?: number;
  concurrency?: number;
};

type ScanIntentInput = {
  baseDir?: string;
};

type FileSearchQueryIntentInput = {
  query: string;
  mode?: 'fts' | 'semantic' | 'hybrid';
  limit?: number;
  baseDir?: string;
};

type ProjectRegistryIntentInput = {
  baseDir: string;
};

type PollingStatusIntentInput = {
  baseDir?: string;
};

type PollingEnableIntentInput = {
  baseDir?: string;
  pollIntervalSeconds?: number;
  idleDisableAfterPolls?: number;
};

type PollingDisableIntentInput = {
  baseDir?: string;
  reason?: string;
};

const memoryScopeSchema = z.enum(['project', 'dir', 'user', 'agent']);
const memoryIdentitySchema = z.object({
  namespace: z.string().trim().min(1),
  leafName: z.string().trim().min(1),
  parentContext: z.string().trim().min(1).optional(),
}).strict();
const memoryContentSchema = z.object({
  text: z.string().trim().min(1).optional(),
  structured: z.record(z.unknown()).optional(),
}).strict().refine((content) => content.text !== undefined || content.structured !== undefined, {
  message: 'content must include text or structured',
});
const storeIntentSchema = z.object({
  scope: memoryScopeSchema,
  identity: memoryIdentitySchema,
  content: memoryContentSchema,
  provenance: z.object({
    source: z.string().trim().min(1),
    timestamp: z.string().trim().min(1).optional(),
    adapter: z.string().trim().min(1).optional(),
    origin: z.string().trim().min(1).optional(),
  }).strict().optional(),
}).strict();
const pruneIntentSchema = z.object({
  scope: memoryScopeSchema,
  identity: memoryIdentitySchema.optional(),
  id: z.string().trim().min(1).optional(),
}).strict().refine((intent) => intent.identity !== undefined || intent.id !== undefined, {
  message: 'prune must include id or identity',
});
const scanIntentSchema = z.object({
  baseDir: z.string().trim().min(1).optional(),
}).strict();
const fileSearchQueryIntentSchema = z.object({
  query: z.string().trim().min(1),
  mode: z.enum(['fts', 'semantic', 'hybrid']).optional(),
  limit: z.number().int().positive().optional(),
  baseDir: z.string().trim().min(1).optional(),
}).strict();
const refreshIntentSchema = z.object({
  baseDir: z.string().trim().min(1).optional(),
  limit: z.number().int().positive().optional(),
  concurrency: z.number().int().positive().optional(),
}).strict();
const projectRegistryIntentSchema = z.object({
  baseDir: z.string().trim().min(1),
}).strict();
const pollingStatusIntentSchema = z.object({
  baseDir: z.string().trim().min(1).optional(),
}).strict();
const pollingEnableIntentSchema = z.object({
  baseDir: z.string().trim().min(1).optional(),
  pollIntervalSeconds: z.number().int().positive().optional(),
  idleDisableAfterPolls: z.number().int().positive().optional(),
}).strict();
const pollingDisableIntentSchema = z.object({
  baseDir: z.string().trim().min(1).optional(),
  reason: z.string().trim().min(1).optional(),
}).strict();

export type OperationsMcpRuntimeContext = ReadOnlyMcpRuntimeContext;

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function normalizeRequiredBaseDir(value: unknown): string {
  const baseDir = normalizeText(value);
  if (!baseDir) throw new Error('Invalid file-search project baseDir');
  return resolve(baseDir);
}

function normalizePositiveInteger(value: unknown, name: string, fallback?: number): number {
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Invalid ${name}: value is required`);
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new Error(`Invalid ${name}: must be a positive integer`);
  return value;
}

function resolveFileSearchTargetBaseDir(baseDir: unknown): string {
  if (baseDir !== undefined) return normalizeRequiredBaseDir(baseDir);
  const activeProject = resolveActiveProjectContext(process.env, process.cwd());
  const resolved = normalizeText(activeProject.repoRoot);
  if (!resolved) throw new Error('Unable to resolve active project for file-search operations; provide baseDir');
  return resolve(resolved);
}

function resolveActivePollingTargetBaseDir(baseDir: unknown): string {
  const cwd = process.cwd();
  if (!cwd.trim()) throw new Error('no-active-project: unable to resolve active project for file-search polling');
  const activeProject = resolveActiveProjectContext(process.env, cwd);
  const activeBaseDir = normalizeText(activeProject.repoRoot);
  if (!activeBaseDir) throw new Error('no-active-project: unable to resolve active project for file-search polling');
  if (baseDir === undefined) return resolve(activeBaseDir);
  const explicitBaseDir = normalizeRequiredBaseDir(baseDir);
  if (explicitBaseDir !== resolve(activeBaseDir)) throw new Error('not-active-project: file-search polling can only be enabled for the active project');
  return explicitBaseDir;
}

function openDirectFileSearchDb(runtime: OperationsMcpRuntimeContext, baseDir: string) {
  return openFileSearchDb({
    baseDir,
    projectBaseDir: baseDir,
    dbBaseDir: runtime.runtimeBaseDir,
    embeddingBaseUrl: runtime.embeddingConfig.embeddingBaseUrl,
    embeddingModel: runtime.embeddingConfig.embeddingModel,
    embeddingDimension: runtime.embeddingConfig.embeddingDimension,
    embeddingTimeoutMs: runtime.embeddingConfig.embeddingTimeoutMs,
    embeddingRequireRemote: Boolean(runtime.embeddingConfig.embeddingBaseUrl),
    embeddingBatchSize: runtime.fileSearchConfig.embeddingBatchSize,
    embeddingConcurrency: runtime.fileSearchConfig.embeddingConcurrency,
    scanOnOpen: false,
    schedulerEnabled: false,
    scannerExcludedExtensions: runtime.fileSearchConfig.excludedExtensions,
    scannerBinaryDetectionEnabled: runtime.fileSearchConfig.binaryDetectionEnabled,
  });
}

function openDirectFileSearchRegistryDb(runtime: OperationsMcpRuntimeContext) {
  return openFileSearchRegistryDb({ dbBaseDir: runtime.runtimeBaseDir });
}

function serializeFileSearchResult(result: { id?: unknown; score?: unknown; file?: { projectKey?: unknown; path?: unknown; chunkIndex?: unknown; chunkText?: unknown; chunkHash?: unknown; startLine?: unknown; endLine?: unknown; lexicalScore?: unknown; semanticScore?: unknown } }) {
  const file = result.file;
  return {
    id: typeof result.id === 'string' ? result.id : undefined,
    score: typeof result.score === 'number' ? result.score : undefined,
    file: file ? {
      project_key: typeof file.projectKey === 'string' ? file.projectKey : undefined,
      path: typeof file.path === 'string' ? file.path : undefined,
      chunk_index: typeof file.chunkIndex === 'number' ? file.chunkIndex : undefined,
      chunk_text: typeof file.chunkText === 'string' ? redactSensitiveFileSearchText(file.chunkText) : undefined,
      chunk_hash: typeof file.chunkHash === 'string' ? file.chunkHash : undefined,
      start_line: typeof file.startLine === 'number' ? file.startLine : undefined,
      end_line: typeof file.endLine === 'number' ? file.endLine : undefined,
      lexical_score: typeof file.lexicalScore === 'number' ? file.lexicalScore : undefined,
      semantic_score: typeof file.semanticScore === 'number' ? file.semanticScore : undefined,
    } : undefined,
  };
}

async function searchFileIndexDirect(runtime: OperationsMcpRuntimeContext, targetBaseDir: string, query: FileSearchQueryIntentInput) {
  const fileDb = openDirectFileSearchDb(runtime, targetBaseDir);
  try {
    const store = {
      baseDir: targetBaseDir,
      fileSearchDb: fileDb,
      fileSearchProjectBaseDir: targetBaseDir,
    } as never;
    const hits = await searchFileIndexForTool(store, query as never);
    const results = hits.map(serializeFileSearchResult);
    const semantic = await buildSearchSemanticMetadata(store, query as never, hits);
    return { results, semantic };
  } finally {
    fileDb.close();
  }
}

function serializeFileSearchProjectEntry(entry: FileSearchProjectEntry) {
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

function serializeFileSearchProjectEntries(entries: FileSearchProjectEntry[]) {
  return entries.map((entry) => serializeFileSearchProjectEntry(entry));
}

export function registerOperationsTools(server: McpServer, getRuntimeContext: () => OperationsMcpRuntimeContext): void {
  const registerTool = server.registerTool.bind(server) as (...args: any[]) => void;

  registerTool(
    'store',
    {
      description: 'Persist one validated memory record in the native store.',
      inputSchema: storeIntentSchema,
    },
    async (params: unknown) => {
      const runtime = getRuntimeContext();
      const intent = storeIntentSchema.parse(params) as StoreIntentInput;
      const record = await runtime.nativeStore.write(intent as never);
      return {
        content: [{ type: 'text', text: safeJson({ tool: 'store', record }) }],
      };
    },
  );

  registerTool(
    'prune',
    {
      description: 'Remove one validated memory record from the native store.',
      inputSchema: pruneIntentSchema,
    },
    async (params: unknown) => {
      const runtime = getRuntimeContext();
      const intent = pruneIntentSchema.parse(params) as PruneIntentInput;
      const id = intent.id ?? normalizeStableKey(intent.scope as never, intent.identity as never);
      const removed = runtime.nativeStore.prune(id) ?? null;
      return {
        content: [{ type: 'text', text: safeJson({ tool: 'prune', id, deleted: Boolean(removed), removed }) }],
      };
    },
  );

  registerTool(
    'scan',
    {
      description: 'Run an explicit file-search scan for a project.',
      inputSchema: scanIntentSchema,
    },
    async (params: unknown) => {
      const runtime = getRuntimeContext();
      const intent = scanIntentSchema.parse(params) as ScanIntentInput;
      const targetBaseDir = resolveFileSearchTargetBaseDir(intent.baseDir);
      const fileDb = openDirectFileSearchDb(runtime, targetBaseDir);
      try {
        const scanner = fileDb.scanAndIndex({ trigger: 'manual' });
        const status = fileDb.getScannerStatus();
        return {
          content: [{ type: 'text', text: safeJson({ tool: 'scan', baseDir: targetBaseDir, scanner, status }) }],
        };
      } finally {
        fileDb.close();
      }
    },
  );

  registerTool(
    'byomem_file_search',
    {
      description: 'Search indexed project files without mutating memory state. Provide query; mode defaults to hybrid, limit defaults to 10, and baseDir is optional.',
      inputSchema: fileSearchQueryIntentSchema,
    },
    async (params: unknown) => {
      const runtime = getRuntimeContext();
      const intent = fileSearchQueryIntentSchema.parse(params) as FileSearchQueryIntentInput;
      const targetBaseDir = resolveFileSearchTargetBaseDir(intent.baseDir);
      const payload = await searchFileIndexDirect(runtime, targetBaseDir, {
        query: intent.query,
        mode: intent.mode ?? 'hybrid',
        limit: intent.limit ?? 10,
      });
      return {
        content: [{ type: 'text', text: safeJson(payload) }],
        details: payload,
        ...payload,
      };
    },
  );

  registerTool(
    'refresh',
    {
      description: 'Refresh semantic file-search embeddings for a project.',
      inputSchema: refreshIntentSchema,
    },
    async (params: unknown) => {
      const runtime = getRuntimeContext();
      const intent = refreshIntentSchema.parse(params) as RefreshIntentInput;
      const targetBaseDir = resolveFileSearchTargetBaseDir(intent.baseDir);
      const fileDb = openDirectFileSearchDb(runtime, targetBaseDir);
      try {
        const diagnostics = await fileDb.refreshSemanticIndex((intent.limit === undefined && intent.concurrency === undefined) ? undefined : { limit: intent.limit, concurrency: intent.concurrency });
        return {
          content: [{ type: 'text', text: safeJson({ tool: 'refresh', baseDir: targetBaseDir, diagnostics }) }],
        };
      } finally {
        fileDb.close();
      }
    },
  );

  registerTool(
    'byomem_file_search_project_register',
    {
      description: 'Register a project for file search using the global registry DB.',
      inputSchema: projectRegistryIntentSchema,
    },
    async (params: unknown) => {
      const runtime = getRuntimeContext();
      const intent = projectRegistryIntentSchema.parse(params) as ProjectRegistryIntentInput;
      const baseDir = normalizeRequiredBaseDir(intent.baseDir);
      const registryDb = openDirectFileSearchRegistryDb(runtime);
      try {
        const project = registerFileSearchProject(registryDb.db, baseDir);
        const serialized = serializeFileSearchProjectEntry(project);
        return {
          content: [{ type: 'text', text: safeJson({ project: serialized }) }],
        };
      } finally {
        registryDb.close();
      }
    },
  );

  registerTool(
    'byomem_file_search_project_list',
    {
      description: 'List registered file-search projects without scanning.',
      inputSchema: z.object({}).strict(),
    },
    async () => {
      const runtime = getRuntimeContext();
      const registryDb = openDirectFileSearchRegistryDb(runtime);
      try {
        const projects = serializeFileSearchProjectEntries(listFileSearchProjects(registryDb.db));
        return {
          content: [{ type: 'text', text: safeJson({ projects }) }],
        };
      } finally {
        registryDb.close();
      }
    },
  );

  registerTool(
    'byomem_file_search_project_unregister',
    {
      description: 'Soft-disable a registered file-search project.',
      inputSchema: projectRegistryIntentSchema,
    },
    async (params: unknown) => {
      const runtime = getRuntimeContext();
      const intent = projectRegistryIntentSchema.parse(params) as ProjectRegistryIntentInput;
      const baseDir = normalizeRequiredBaseDir(intent.baseDir);
      const registryDb = openDirectFileSearchRegistryDb(runtime);
      try {
        const project = unregisterFileSearchProject(registryDb.db, baseDir);
        const serialized = serializeFileSearchProjectEntry(project);
        return {
          content: [{ type: 'text', text: safeJson({ project: serialized }) }],
        };
      } finally {
        registryDb.close();
      }
    },
  );

  registerTool(
    'byomem_file_search_polling_status',
    {
      description: 'Inspect file-search polling state for the active project or a provided baseDir.',
      inputSchema: pollingStatusIntentSchema,
    },
    async (params: unknown) => {
      const runtime = getRuntimeContext();
      const intent = pollingStatusIntentSchema.parse(params) as PollingStatusIntentInput;
      const targetBaseDir = resolveFileSearchTargetBaseDir(intent.baseDir);
      const polling = getFileSearchPollingStatus(targetBaseDir, { dbBaseDir: runtime.runtimeBaseDir });
      const payload = { polling, status: polling };
      return {
        content: [{ type: 'text', text: safeJson(payload) }],
      };
    },
  );

  registerTool(
    'byomem_file_search_polling_enable',
    {
      description: 'Enable file-search polling for the active project.',
      inputSchema: pollingEnableIntentSchema,
    },
    async (params: unknown) => {
      const runtime = getRuntimeContext();
      const intent = pollingEnableIntentSchema.parse(params) as PollingEnableIntentInput;
      const targetBaseDir = resolveActivePollingTargetBaseDir(intent.baseDir);
      const pollIntervalSeconds = normalizePositiveInteger(intent.pollIntervalSeconds, 'pollIntervalSeconds', 60);
      const idleDisableAfterPolls = intent.idleDisableAfterPolls === undefined ? undefined : normalizePositiveInteger(intent.idleDisableAfterPolls, 'idleDisableAfterPolls');
      const polling = configureFileSearchPolling(targetBaseDir, {
        pollIntervalSeconds,
        idleDisableAfterPolls,
        dbBaseDir: runtime.runtimeBaseDir,
      });
      const payload = { polling, status: polling };
      return {
        content: [{ type: 'text', text: safeJson(payload) }],
      };
    },
  );

  registerTool(
    'byomem_file_search_polling_disable',
    {
      description: 'Disable file-search polling for the active project.',
      inputSchema: pollingDisableIntentSchema,
    },
    async (params: unknown) => {
      const runtime = getRuntimeContext();
      const intent = pollingDisableIntentSchema.parse(params) as PollingDisableIntentInput;
      const targetBaseDir = resolveActivePollingTargetBaseDir(intent.baseDir);
      const reason = intent.reason === undefined ? 'manually-disabled' : intent.reason;
      const polling = disableFileSearchPolling(targetBaseDir, reason as FileSearchPollingDisabledReason, { dbBaseDir: runtime.runtimeBaseDir });
      const payload = { polling, status: polling };
      return {
        content: [{ type: 'text', text: safeJson(payload) }],
      };
    },
  );
}
