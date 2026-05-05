import type { NativeStore } from './store.js';
import {
  applyQueryBoost,
  buildSearchResult,
  candidateScoreMap,
  chunkKey,
  type FileSearchChunkRow,
  type FileSearchSearchMode,
  type FileSearchSearchResult,
  inferFileSearchLanguage,
  normalizeRrf,
  resolveAlpha,
  rerankTopK,
  tokenizeSearchQuery,
  boostMultiChunkFiles,
} from './file-search-semble.js';
import { cosineSimilarity, decodeEmbedding } from './embedding-vector.js';
import { FILE_SEARCH_EMBEDDING_IDENTITY_VERSION } from './embedding-client.js';
import { containsSensitiveFileSearchContent, isIgnoredFileSearchArtifact, resolveFileSearchProjectKey } from './file-search-db.js';
import { markFileSearchProjectSeen } from './file-search-project-registry.js';

export interface FileSearchQuery {
  query: string;
  scope?: 'project' | 'dir' | 'user' | 'agent';
  limit?: number;
  mode?: FileSearchSearchMode;
}

export type FileSearchHit = FileSearchSearchResult;

type FileSearchRow = {
  project_key: string;
  path: string;
  chunk_index: number;
  chunk_text: string;
  search_text: string;
  chunk_hash: string;
  start_line?: number | null;
  end_line?: number | null;
  content_hash: string | null;
};

type ScoredRow = FileSearchChunkRow;

function canonicalProjectKey(baseDir: string): string {
  return resolveFileSearchProjectKey(baseDir);
}

function tokenize(query: string): string[] {
  return Array.from(new Set(tokenizeSearchQuery(query)));
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;

type LexicalRow = ScoredRow & {
  search_text: string;
};

function loadAllChunks(db: NonNullable<NativeStore['fileSearchDb']>['db'], projectKey: string): LexicalRow[] {
  const rows = db.prepare(`
    SELECT fr.project_key, fr.path, fc.chunk_index, fc.chunk_text, fc.search_text, fc.chunk_hash, fc.start_line, fc.end_line, fr.content_hash
    FROM indexed_chunks fc
    JOIN file_records fr ON fr.id = fc.file_record_id
    WHERE fr.project_key = ?
    ORDER BY fc.file_record_id, fc.chunk_index
  `).all(projectKey) as FileSearchRow[];
  return rows.map((row) => ({
    projectKey: row.project_key,
    filePath: row.path,
    content: row.chunk_text,
    search_text: row.search_text ?? row.chunk_text,
    startLine: typeof row.start_line === 'number' ? row.start_line : row.chunk_index + 1,
    endLine: typeof row.end_line === 'number' ? row.end_line : row.chunk_index + 1,
    hasLineMetadata: typeof row.start_line === 'number' && typeof row.end_line === 'number',
    chunkIndex: row.chunk_index,
    chunkHash: row.chunk_hash,
    language: inferFileSearchLanguage(row.path),
  }));
}

function queryLexicalBm25(db: NonNullable<NativeStore['fileSearchDb']>['db'], projectKey: string, query: string, limit: number): ScoredRow[] {
  const queryTokens = Array.from(new Set(tokenize(query)));
  if (!queryTokens.length) return [];
  const queryTerms = new Set(queryTokens);
  const rows = loadAllChunks(db, projectKey);
  if (!rows.length) return [];

  const candidates: Array<{ row: LexicalRow; docLength: number; termFrequency: Map<string, number> }> = [];
  const docFrequencies = new Map<string, number>();
  let totalDocLength = 0;

  for (const row of rows) {
    const docTokens = tokenizeSearchQuery(row.search_text);
    const docLength = docTokens.length;
    totalDocLength += docLength;
    const termFrequency = new Map<string, number>();
    const seen = new Set<string>();
    for (const token of docTokens) {
      if (!queryTerms.has(token)) continue;
      termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
      if (!seen.has(token)) {
        seen.add(token);
        docFrequencies.set(token, (docFrequencies.get(token) ?? 0) + 1);
      }
    }
    if (termFrequency.size) candidates.push({ row, docLength, termFrequency });
  }

  if (!candidates.length) return [];
  const averageDocLength = totalDocLength / rows.length || 1;
  const totalDocs = rows.length;

  return candidates
    .map(({ row, docLength, termFrequency }) => {
      let score = 0;
      for (const token of queryTokens) {
        const tf = termFrequency.get(token) ?? 0;
        if (!tf) continue;
        const df = docFrequencies.get(token) ?? 0;
        if (!df) continue;
        const idf = Math.log1p((totalDocs - df + 0.5) / (df + 0.5));
        const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLength / averageDocLength));
        score += idf * ((tf * (BM25_K1 + 1)) / denominator);
      }
      return { row, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.row.filePath.localeCompare(b.row.filePath) || a.row.chunkIndex - b.row.chunkIndex)
    .slice(0, limit)
    .map(({ row, score }) => {
      const { search_text: _searchText, ...baseRow } = row;
      return { ...baseRow, lexicalScore: score, score };
    });
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
  `).all(projectKey, fileDb.embeddingProviderKey, fileDb.embeddingModel, fileDb.embeddingConfiguredDimension, FILE_SEARCH_EMBEDDING_IDENTITY_VERSION, queryDimension, fileDb.embeddingConfiguredDimension, fileDb.embeddingConfiguredDimension) as Array<FileSearchRow & { embedding: Buffer; dimension: number }>;
  return rows
    .map((row) => {
      const semanticScore = cosineSimilarity(queryVector, decodeEmbedding(row.embedding, row.dimension));
      return {
        projectKey: row.project_key,
        filePath: row.path,
        content: row.chunk_text,
        startLine: typeof row.start_line === 'number' ? row.start_line : row.chunk_index + 1,
        endLine: typeof row.end_line === 'number' ? row.end_line : row.chunk_index + 1,
        hasLineMetadata: typeof row.start_line === 'number' && typeof row.end_line === 'number',
        chunkIndex: row.chunk_index,
        chunkHash: row.chunk_hash,
        language: inferFileSearchLanguage(row.path),
        semanticScore,
        score: semanticScore,
      };
    })
    .sort((a, b) => (b.semanticScore ?? 0) - (a.semanticScore ?? 0) || a.filePath.localeCompare(b.filePath) || a.chunkIndex - b.chunkIndex)
    .slice(0, limit);
}

function isSafeFileSearchRow(row: Pick<ScoredRow, 'filePath' | 'content'>): boolean {
  return !isIgnoredFileSearchArtifact(row.filePath) && !containsSensitiveFileSearchContent(row.content);
}

export function redactSensitiveFileSearchText(text: string): string {
  return containsSensitiveFileSearchContent(text) ? '[redacted sensitive file-search chunk]' : text;
}

function buildHit(row: ScoredRow, source: FileSearchSearchMode): FileSearchHit {
  return buildSearchResult(row, source, redactSensitiveFileSearchText);
}

function blendHits(ftsRows: ScoredRow[], semanticRows: ScoredRow[], limit: number, query: string, allRows: ScoredRow[]): ScoredRow[] {
  const candidateRows = candidateScoreMap([...ftsRows, ...semanticRows, ...allRows]);
  const ftsScores = normalizeRrf(new Map(ftsRows.map((row) => [chunkKey(row), row.lexicalScore ?? row.score ?? 0])));
  const semanticScores = normalizeRrf(new Map(semanticRows.map((row) => [chunkKey(row), row.semanticScore ?? row.score ?? 0])));
  const alphaWeight = resolveAlpha(query, undefined);
  const combinedScores = new Map<string, number>();

  for (const key of new Set([...ftsScores.keys(), ...semanticScores.keys()])) {
    combinedScores.set(key, (alphaWeight * (semanticScores.get(key) ?? 0)) + ((1 - alphaWeight) * (ftsScores.get(key) ?? 0)));
  }

  boostMultiChunkFiles(combinedScores, candidateRows);
  const boostedScores = applyQueryBoost(combinedScores, query, candidateRows);
  const ranked = rerankTopK(boostedScores, candidateRows, limit, alphaWeight < 1.0, query);
  return ranked.map((entry) => ({ ...entry.chunk, score: entry.score }));
}

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
  };
}

function findSourceChunk(rows: ScoredRow[], filePath: string, line: number): ScoredRow | undefined {
  return rows.find((row) => row.filePath === filePath && row.startLine <= line && row.endLine >= line)
    ?? rows.find((row) => row.filePath === filePath && row.chunkIndex === Math.max(0, line - 1));
}

export async function findRelated(store: NativeStore, query: { filePath: string; line: number; limit?: number }): Promise<FileSearchHit[]> {
  const fileDb = store.fileSearchDb;
  if (!fileDb) return [];
  if (query.limit !== undefined && query.limit < 1) return [];
  const projectBaseDir = store.fileSearchProjectBaseDir ?? store.baseDir;
  markFileSearchProjectSeen(fileDb.db, projectBaseDir, 'manual-search');
  const projectKey = canonicalProjectKey(projectBaseDir);
  const allRows = loadAllChunks(fileDb.db, projectKey);
  const seed = findSourceChunk(allRows, query.filePath, query.line);
  if (!seed) return [];
  const seedLanguage = seed.language ?? inferFileSearchLanguage(seed.filePath);
  const candidateCount = Math.max(2, (query.limit ?? 5) * 5);
  const semanticRows = await querySemantic(store, projectKey, seed.content, candidateCount);
  const safeSemanticRows = semanticRows.filter(isSafeFileSearchRow).filter((row) => row.filePath !== seed.filePath || row.chunkIndex !== seed.chunkIndex);
  const filtered = seedLanguage
    ? safeSemanticRows.filter((row) => (row.language ?? inferFileSearchLanguage(row.filePath)) === seedLanguage)
    : safeSemanticRows;
  if (filtered.length) return filtered.slice(0, query.limit ?? 5).map((row) => buildHit(row, 'semantic'));

  const fallbackQuery = Array.from(new Set(tokenizeSearchQuery(seed.content))).slice(0, 3).join(' ') || seed.content;
  const fallbackHits = await searchIndex(store, { query: fallbackQuery, scope: 'project', mode: 'hybrid', limit: candidateCount });
  const fallback = fallbackHits
    .filter((hit) => {
      const path = hit.file?.path ?? hit.chunk.filePath;
      return !isIgnoredFileSearchArtifact(path) && !containsSensitiveFileSearchContent(hit.chunk.content);
    })
    .filter((hit) => {
      const path = hit.file?.path ?? hit.chunk.filePath;
      const chunkIndex = hit.file?.chunkIndex;
      return path !== seed.filePath || chunkIndex !== seed.chunkIndex;
    })
    .filter((hit) => {
      const path = hit.file?.path ?? hit.chunk.filePath;
      return seedLanguage ? (hit.chunk.language ?? inferFileSearchLanguage(path)) === seedLanguage : true;
    });
  return fallback.slice(0, query.limit ?? 5);
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
  const overFetch = mode === 'hybrid' ? limit * 5 : limit;
  const lexicalRows = queryLexicalBm25(fileDb.db, projectKey, query.query, overFetch);
  const safeLexicalRows = lexicalRows.filter(isSafeFileSearchRow);
  if (mode === 'fts') return safeLexicalRows.slice(0, limit).map((row) => buildHit(row, 'fts'));

  const semanticRows = await querySemantic(store, projectKey, query.query, overFetch);
  const safeSemanticRows = semanticRows.filter(isSafeFileSearchRow);
  if (mode === 'semantic') return safeSemanticRows.slice(0, limit).map((row) => buildHit(row, 'semantic'));
  if (!safeSemanticRows.length) return safeLexicalRows.slice(0, limit).map((row) => buildHit(row, 'fts'));

  const allRows = loadAllChunks(fileDb.db, projectKey);
  const blended = blendHits(safeLexicalRows, safeSemanticRows, limit, query.query, allRows);
  return (blended.length ? blended : safeSemanticRows.slice(0, limit)).map((row) => buildHit(row, 'hybrid'));
}
