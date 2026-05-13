import type { NativeStore } from './store.js';
import { buildFileSearchIndex, type FileSearchIndexFindRelatedOptions, type FileSearchIndexSearchOptions, type FileSearchIndexSeed, type FileSearchIndexStats } from './file-search-index.js';
import type { FileSearchSearchMode, FileSearchSearchResult } from './file-search-semble.js';
import { containsSensitiveFileSearchContent } from './file-search-db.js';

export interface FileSearchQuery {
  query: string;
  scope?: 'project' | 'dir' | 'user' | 'agent';
  limit?: number;
  mode?: FileSearchSearchMode;
}

export type FileSearchHit = FileSearchSearchResult;

export interface FileSearchSemanticMetadata {
  requested: boolean;
  enabled: boolean;
  used: boolean;
  state: string;
  refreshNeeded: boolean;
  incompatible: boolean;
  projectKey: string;
  baseUrl?: string;
  providerKey: string;
  requireRemote: boolean;
  model: string;
  configuredDimension: number;
  actualDimensions: Array<{ dimension: number; chunks: number }>;
  queryDimension?: number;
  queryDimensionCompatible?: boolean;
  embeddedChunks: number;
  missingChunks: number;
  incompatibleChunks: number;
  refreshNeededChunks: number;
  failedChunks: number;
  failures: number;
  refreshCommand: 'file-search-semantic-refresh';
  refreshTool: 'byomem_file_search_semantic_refresh';
  degraded?: boolean;
  degradeReason?: string;
}

export function redactSensitiveFileSearchText(text: string): string {
  return containsSensitiveFileSearchContent(text) ? '[redacted sensitive file-search chunk]' : text;
}

function normalizeIndexSearchOptions(query: FileSearchQuery): FileSearchIndexSearchOptions {
  return {
    mode: query.mode ?? 'hybrid',
    topK: query.limit,
  };
}

function normalizeIndexFindRelatedOptions(query: { limit?: number }): FileSearchIndexFindRelatedOptions {
  return {
    topK: query.limit,
  };
}

export async function buildSearchSemanticMetadata(store: NativeStore, query: FileSearchQuery, hits?: FileSearchHit[]): Promise<FileSearchSemanticMetadata | undefined> {
  const fileDb = store.fileSearchDb;
  const mode = query.mode ?? 'hybrid';
  if (!fileDb || mode === 'bm25') return undefined;
  const diagnostics = fileDb.getEmbeddingDiagnostics();
  const used = Boolean(hits?.some((hit) => hit.file?.semanticScore !== undefined));
  const memoryGuard = buildFileSearchIndex(store).hotIndexInfo.memoryGuard;
  return {
    requested: true,
    enabled: diagnostics.enabled,
    used,
    state: diagnostics.state,
    refreshNeeded: diagnostics.refreshNeededChunks > 0,
    incompatible: diagnostics.incompatibleChunks > 0,
    projectKey: diagnostics.projectKey,
    baseUrl: diagnostics.baseUrl,
    providerKey: diagnostics.providerKey,
    requireRemote: diagnostics.requireRemote,
    model: diagnostics.model,
    configuredDimension: diagnostics.configuredDimension,
    actualDimensions: diagnostics.actualDimensions,
    embeddedChunks: diagnostics.embeddedChunks,
    missingChunks: diagnostics.missingChunks,
    incompatibleChunks: diagnostics.incompatibleChunks,
    refreshNeededChunks: diagnostics.refreshNeededChunks,
    failedChunks: diagnostics.failedChunks,
    failures: diagnostics.failures,
    refreshCommand: 'file-search-semantic-refresh',
    refreshTool: 'byomem_file_search_semantic_refresh',
    ...(memoryGuard?.degraded ? { degraded: true, degradeReason: memoryGuard.reason ?? 'memory-guard' } : {}),
  };
}

export async function findRelated(store: NativeStore, query: { filePath: string; line: number; limit?: number }): Promise<FileSearchHit[]> {
  const fileDb = store.fileSearchDb;
  if (!fileDb) return [];
  if (query.limit !== undefined && query.limit < 1) return [];
  const index = buildFileSearchIndex(store);
  return index.findRelated({ filePath: query.filePath, line: query.line }, normalizeIndexFindRelatedOptions(query));
}

export async function searchIndex(store: NativeStore, query: FileSearchQuery): Promise<FileSearchHit[]> {
  const fileDb = store.fileSearchDb;
  if (!fileDb) return [];
  if (query.scope && query.scope !== 'project') return [];
  const index = buildFileSearchIndex(store);
  return index.search(query.query, normalizeIndexSearchOptions(query));
}

export type { FileSearchIndexStats, FileSearchIndexSeed };
