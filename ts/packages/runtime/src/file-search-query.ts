import type { MemoryRecord } from './contracts.js';
import type { NativeStore } from './store.js';
import { normalizeIdentity } from './identity.js';
import { containsSensitiveFileSearchContent, isIgnoredFileSearchArtifact, resolveFileSearchProjectKey } from './file-search-db.js';
import { markFileSearchProjectSeen } from './file-search-project-registry.js';
import { cosineSimilarity, decodeEmbedding } from './embedding-vector.js';
import { FILE_SEARCH_EMBEDDING_IDENTITY_VERSION } from './embedding-client.js';

export interface FileSearchQuery {
  query: string;
  scope?: 'project' | 'dir' | 'user' | 'agent';
  limit?: number;
  mode?: 'fts' | 'semantic' | 'hybrid';
}

export interface FileSearchHit extends MemoryRecord {
  score?: number;
  file?: {
    projectKey: string;
    path: string;
    chunkIndex?: number;
    chunkText?: string;
    chunkHash?: string;
    startLine?: number;
    endLine?: number;
    lexicalScore?: number;
    semanticScore?: number;
  };
}

type FileSearchRow = {
  project_key: string;
  path: string;
  chunk_index: number;
  chunk_text: string;
  chunk_hash: string;
  start_line?: number | null;
  end_line?: number | null;
  content_hash: string | null;
};

type ScoredRow = FileSearchRow & { lexicalScore?: number; semanticScore?: number; score?: number };

function canonicalProjectKey(baseDir: string): string {
  return resolveFileSearchProjectKey(baseDir);
}

function tokenize(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function queryFts(db: NonNullable<NativeStore['fileSearchDb']>['db'], projectKey: string, query: string, limit: number): ScoredRow[] {
  const tokens = tokenize(query);
  if (!tokens.length) return [];
  const ftsQuery = tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' ');
  const rows = db.prepare(`
    SELECT fr.project_key, fr.path, fc.chunk_index, fc.chunk_text, fc.chunk_hash, fc.start_line, fc.end_line, fr.content_hash, bm25(indexed_chunks_fts) AS rank
    FROM indexed_chunks fc
    JOIN file_records fr ON fr.id = fc.file_record_id
    JOIN indexed_chunks_fts ON indexed_chunks_fts.rowid = fc.rowid
    WHERE fr.project_key = ? AND indexed_chunks_fts MATCH ?
    ORDER BY bm25(indexed_chunks_fts), fc.created_at DESC, fc.chunk_index ASC
    LIMIT ?
  `).all(projectKey, ftsQuery, limit) as Array<FileSearchRow & { rank: number }>;
  return rows.map((row, index) => ({
    ...row,
    lexicalScore: Math.max(0.01, 1 - (index * 0.01)),
    score: Math.max(0.01, 1 - (index * 0.01)),
  }));
}

async function querySemantic(store: NativeStore, projectKey: string, query: string, limit: number): Promise<ScoredRow[]> {
  const fileDb = store.fileSearchDb;
  if (!fileDb?.semanticSearchEnabled) return [];
  const diagnostics = fileDb.getEmbeddingDiagnostics();
  if (diagnostics.embeddedChunks <= 0) return [];
  const queryVector = await fileDb.embedQuery(query);
  if (!queryVector?.length) return [];
  const queryDimension = queryVector.length;
  const rows = fileDb.db.prepare(`
    SELECT fr.project_key, fr.path, fc.chunk_index, fc.chunk_text, fc.chunk_hash, fc.start_line, fc.end_line, fr.content_hash, e.embedding, e.dimension
    FROM indexed_chunk_embeddings e
    JOIN indexed_chunks fc ON fc.id = e.chunk_id
    JOIN file_records fr ON fr.id = fc.file_record_id
    WHERE e.project_key = ?
      AND e.provider_key = ?
      AND e.model = ?
      AND e.configured_dimension = ?
      AND e.status = 'ready'
      AND e.chunk_hash = fc.chunk_hash
      AND e.identity_version = ?
      AND e.dimension = ?
      AND (? = 0 OR e.dimension = ?)
    ORDER BY e.updated_at DESC
  `).all(projectKey, fileDb.embeddingProviderKey, fileDb.embeddingModel, fileDb.embeddingConfiguredDimension, FILE_SEARCH_EMBEDDING_IDENTITY_VERSION, queryDimension, fileDb.embeddingConfiguredDimension, fileDb.embeddingConfiguredDimension) as Array<FileSearchRow & { embedding: Buffer; dimension: number }>;
  return rows
    .map((row) => {
      const semanticScore = cosineSimilarity(queryVector, decodeEmbedding(row.embedding, row.dimension));
      return { ...row, semanticScore, score: semanticScore };
    })
    .sort((a, b) => (b.semanticScore ?? 0) - (a.semanticScore ?? 0) || a.path.localeCompare(b.path) || a.chunk_index - b.chunk_index)
    .slice(0, limit);
}

function hitId(row: { project_key: string; path: string; chunk_index: number }): string {
  return `${row.project_key}:${row.path}:${row.chunk_index}`;
}

function isSafeFileSearchRow(row: Pick<ScoredRow, 'path' | 'chunk_text'>): boolean {
  return !isIgnoredFileSearchArtifact(row.path) && !containsSensitiveFileSearchContent(row.chunk_text);
}

export function redactSensitiveFileSearchText(text: string): string {
  return containsSensitiveFileSearchContent(text) ? '[redacted sensitive file-search chunk]' : text;
}

function buildHit(row: ScoredRow): FileSearchHit {
  return {
    id: hitId(row),
    scope: 'project',
    identity: normalizeIdentity('project', { namespace: row.project_key, leafName: row.path, parentContext: `chunk-${row.chunk_index}` }),
    provenance: { source: 'file-search', origin: row.semanticScore && !row.lexicalScore ? 'semantic-indexed-chunk' : 'indexed-chunk' },
    content: { text: redactSensitiveFileSearchText(row.chunk_text) },
    metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    score: row.score,
    file: {
      projectKey: row.project_key,
      path: row.path,
      chunkIndex: row.chunk_index,
      chunkText: redactSensitiveFileSearchText(row.chunk_text),
      chunkHash: row.chunk_hash,
      ...(typeof row.start_line === 'number' ? { startLine: row.start_line } : {}),
      ...(typeof row.end_line === 'number' ? { endLine: row.end_line } : {}),
      lexicalScore: row.lexicalScore,
      semanticScore: row.semanticScore,
    },
  };
}

function blendHits(ftsRows: ScoredRow[], semanticRows: ScoredRow[], limit: number): ScoredRow[] {
  const merged = new Map<string, ScoredRow>();
  for (const row of ftsRows) merged.set(hitId(row), { ...row, score: row.lexicalScore ?? row.score ?? 0 });
  for (const row of semanticRows) {
    const id = hitId(row);
    const existing = merged.get(id);
    if (existing) {
      const lexicalScore = existing.lexicalScore ?? 0;
      const semanticScore = row.semanticScore ?? 0;
      merged.set(id, { ...existing, semanticScore, score: (lexicalScore * 0.7) + (semanticScore * 0.3) });
    } else {
      const semanticScore = row.semanticScore ?? 0;
      merged.set(id, { ...row, score: semanticScore * 0.85 });
    }
  }
  return [...merged.values()]
    .filter((row) => (row.score ?? 0) >= 0.3)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.path.localeCompare(b.path) || a.chunk_index - b.chunk_index)
    .slice(0, limit);
}


export interface FileSearchSemanticMetadata {
  requested: boolean;
  enabled: boolean;
  used: boolean;
  state: string;
  refreshNeeded: boolean;
  incompatible: boolean;
  projectKey: string;
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
}

export async function buildSearchSemanticMetadata(store: NativeStore, query: FileSearchQuery, hits?: FileSearchHit[]): Promise<FileSearchSemanticMetadata | undefined> {
  const fileDb = store.fileSearchDb;
  const mode = query.mode ?? 'hybrid';
  if (!fileDb || mode === 'fts') return undefined;
  const diagnostics = fileDb.getEmbeddingDiagnostics();
  const used = Boolean(hits?.some((hit) => hit.file?.semanticScore !== undefined));
  return {
    requested: true,
    enabled: diagnostics.enabled,
    used,
    state: diagnostics.state,
    refreshNeeded: diagnostics.refreshNeededChunks > 0,
    incompatible: diagnostics.incompatibleChunks > 0,
    projectKey: diagnostics.projectKey,
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
  };
}

export async function searchIndex(store: NativeStore, query: FileSearchQuery): Promise<FileSearchHit[]> {
  const fileDb = store.fileSearchDb;
  if (!fileDb) return [];
  if (query.scope && query.scope !== 'project') return [];
  const limit = query.limit ?? 10;
  const projectBaseDir = store.fileSearchProjectBaseDir ?? store.baseDir;
  markFileSearchProjectSeen(fileDb.db, projectBaseDir, 'manual-search');
  const projectKey = canonicalProjectKey(projectBaseDir);
  const mode = query.mode ?? 'hybrid';
  const ftsRows = queryFts(fileDb.db, projectKey, query.query, mode === 'hybrid' ? limit * 2 : limit);
  const safeFtsRows = ftsRows.filter(isSafeFileSearchRow);
  if (mode === 'fts') return safeFtsRows.slice(0, limit).map(buildHit);

  const semanticRows = await querySemantic(store, projectKey, query.query, mode === 'hybrid' ? limit * 2 : limit);
  const safeSemanticRows = semanticRows.filter(isSafeFileSearchRow);
  if (mode === 'semantic') return safeSemanticRows.slice(0, limit).map(buildHit);
  if (!safeSemanticRows.length) return safeFtsRows.slice(0, limit).map(buildHit);
  const blended = blendHits(safeFtsRows, safeSemanticRows, limit);
  return (blended.length ? blended : safeSemanticRows.slice(0, limit)).map(buildHit);
}
