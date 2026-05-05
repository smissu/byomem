import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { NativeStore } from './store.js';
import {
  applyQueryBoost,
  buildSearchResult,
  candidateScoreMap,
  chunkKey,
  inferFileSearchLanguage,
  normalizeRrf,
  resolveAlpha,
  rerankTopK,
  tokenizeSearchQuery,
  boostMultiChunkFiles,
  type FileSearchChunkRow,
  type FileSearchSearchMode,
  type FileSearchSearchResult,
} from './file-search-semble.js';
import { cosineSimilarity, decodeEmbedding } from './embedding-vector.js';
import { FILE_SEARCH_EMBEDDING_IDENTITY_VERSION } from './embedding-client.js';
import { containsSensitiveFileSearchContent, isIgnoredFileSearchArtifact, resolveFileSearchProjectKey } from './file-search-db.js';
import { markFileSearchProjectSeen } from './file-search-project-registry.js';

export type FileSearchIndexMode = 'bm25' | 'semantic' | 'hybrid';

export interface FileSearchIndexSearchOptions {
  topK?: number;
  mode?: FileSearchIndexMode;
  alpha?: number;
  filterLanguages?: string[];
  filterPaths?: string[];
}

export interface FileSearchIndexFindRelatedOptions {
  topK?: number;
  filterLanguages?: string[];
  filterPaths?: string[];
}

export interface FileSearchIndexBuilderOptions {
  baseDir?: string;
  sourceFingerprint?: string;
  repoUrl?: string;
}

export interface FileSearchIndexIdentity {
  sourceType: 'path' | 'git';
  baseDir: string;
  projectKey: string;
  sourceFingerprint: string;
  repoUrl?: string;
}

export interface FileSearchIndexBuildStats {
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
  projectFingerprint: string;
  backendVersion: string;
}

export type FileSearchHotIndexState = 'cold' | 'hydrating' | 'ready' | 'stale' | 'building' | 'failed';

export interface FileSearchHotIndexStats {
  state: FileSearchHotIndexState;
  source: 'none' | 'sqlite' | 'memory';
  chunkCount: number;
  vectorCount: number;
  hydrateCount: number;
  buildCount: number;
  revision: number;
  hydratedRevision?: number;
  lastHydratedAt?: string;
  lastBuiltAt?: string;
  lastError?: string;
  hydrateMs?: number;
  hydrate?: {
    startedAt: string;
    completedAt: string;
    elapsedMs: number;
  };
}

export interface FileSearchIndexStats {
  index: {
    indexedFiles: number;
    chunkCount: number;
    perLanguageCounts: Record<string, number>;
    projectKey: string;
    baseDir: string;
    sourceFingerprint: string;
    sourceType: 'path' | 'git';
    repoUrl?: string;
  };
  build: FileSearchIndexBuildStats;
  embedding: {
    enabled: boolean;
    model: string;
    providerKey: string;
    dimension: number;
    vectorByteSize: number;
    configuredDimension: number;
  };
  hotIndex: FileSearchHotIndexStats;
}

export type FileSearchIndexSeed =
  | { filePath: string; line: number }
  | Pick<FileSearchSearchResult, 'chunk' | 'file'>
  | Pick<FileSearchChunkRow, 'filePath' | 'chunkIndex' | 'content' | 'startLine' | 'endLine' | 'language'>;

type FileSearchIndexedRow = FileSearchChunkRow & { searchText: string };

type HotFileSearchVector = { vector: number[]; dimension: number };

interface HotFileSearchIndexSnapshot {
  rows: FileSearchIndexedRow[];
  vectors: Map<string, HotFileSearchVector>;
  perLanguageCounts: Record<string, number>;
  indexedFiles: number;
  revision: number;
  source: 'sqlite' | 'memory';
  hydrateStartedAt: string;
  hydratedAt: string;
  hydrateMs: number;
}

const BACKEND_VERSION = 'byomem-file-search-index-v1';

function fingerprintText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function normalizeFilterPath(value: string): string {
  return resolve(value).replace(/\\/g, '/');
}

function matchesFilterPath(filePath: string, filterPaths?: string[]): boolean {
  if (!filterPaths?.length) return true;
  const normalized = filePath.replace(/\\/g, '/');
  return filterPaths.some((filterPath) => {
    const filter = normalizeFilterPath(filterPath);
    return normalized === filter || normalized.endsWith(`/${filter}`) || normalized.includes(filter);
  });
}

function matchesFilterLanguage(row: Pick<FileSearchChunkRow, 'filePath' | 'language'>, filterLanguages?: string[]): boolean {
  if (!filterLanguages?.length) return true;
  const language = (row.language ?? inferFileSearchLanguage(row.filePath) ?? 'text').toLowerCase();
  return filterLanguages.some((filterLanguage) => filterLanguage.toLowerCase() === language);
}

function shouldIncludeRow(row: Pick<FileSearchChunkRow, 'filePath' | 'language'>, options: FileSearchIndexSearchOptions | FileSearchIndexFindRelatedOptions): boolean {
  return matchesFilterLanguage(row, options.filterLanguages) && matchesFilterPath(row.filePath, options.filterPaths);
}

function tokenize(query: string): string[] {
  return Array.from(new Set(tokenizeSearchQuery(query)));
}

function loadAllChunks(db: NonNullable<NativeStore['fileSearchDb']>['db'], projectKey: string): FileSearchIndexedRow[] {
  const rows = db.prepare(`
    SELECT fr.project_key, fr.path, fc.chunk_index, fc.chunk_text, fc.search_text, fc.chunk_hash, fc.start_line, fc.end_line
    FROM indexed_chunks fc
    JOIN file_records fr ON fr.id = fc.file_record_id
    WHERE fr.project_key = ?
    ORDER BY fc.file_record_id, fc.chunk_index
  `).all(projectKey) as Array<{
    project_key: string;
    path: string;
    chunk_index: number;
    chunk_text: string;
    search_text: string;
    chunk_hash: string;
    start_line?: number | null;
    end_line?: number | null;
  }>;
  return rows.map((row) => ({
    projectKey: row.project_key,
    filePath: row.path,
    content: row.chunk_text,
    searchText: row.search_text ?? row.chunk_text,
    startLine: typeof row.start_line === 'number' ? row.start_line : row.chunk_index + 1,
    endLine: typeof row.end_line === 'number' ? row.end_line : row.chunk_index + 1,
    hasLineMetadata: typeof row.start_line === 'number' && typeof row.end_line === 'number',
    chunkIndex: row.chunk_index,
    chunkHash: row.chunk_hash,
    language: inferFileSearchLanguage(row.path),
  }));
}

function loadReadyEmbeddingVectors(
  fileDb: NonNullable<NativeStore['fileSearchDb']>,
  projectKey: string,
): Map<string, HotFileSearchVector> {
  const vectors = new Map<string, HotFileSearchVector>();
  const rows = fileDb.db.prepare(`
    SELECT fr.project_key, fr.path, fc.chunk_index, fc.chunk_hash, e.embedding, e.dimension
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
      AND (? = 0 OR e.dimension = ?)
  `).all(projectKey, fileDb.embeddingProviderKey, fileDb.embeddingModel, fileDb.embeddingConfiguredDimension, FILE_SEARCH_EMBEDDING_IDENTITY_VERSION, fileDb.embeddingConfiguredDimension, fileDb.embeddingConfiguredDimension) as Array<{
    project_key: string;
    path: string;
    chunk_index: number;
    chunk_hash: string;
    embedding: Buffer;
    dimension: number;
  }>;
  for (const row of rows) {
    vectors.set(chunkKey({
      projectKey: row.project_key,
      filePath: row.path,
      chunkIndex: row.chunk_index,
    }), {
      vector: decodeEmbedding(row.embedding, row.dimension),
      dimension: row.dimension,
    });
  }
  return vectors;
}

function queryLexicalBm25Rows(
  rows: FileSearchIndexedRow[],
  query: string,
  limit: number,
  options: FileSearchIndexSearchOptions | FileSearchIndexFindRelatedOptions = {},
): FileSearchChunkRow[] {
  const queryTokens = Array.from(new Set(tokenize(query)));
  if (!queryTokens.length) return [];
  const queryTerms = new Set(queryTokens);
  const filteredRows = rows.filter((row) => shouldIncludeRow(row, options));
  if (!filteredRows.length) return [];

  const candidates: Array<{ row: FileSearchIndexedRow; docLength: number; termFrequency: Map<string, number> }> = [];
  const docFrequencies = new Map<string, number>();
  let totalDocLength = 0;

  for (const row of filteredRows) {
    const docTokens = tokenizeSearchQuery(row.searchText);
    const contentTokenCount = tokenizeSearchQuery(row.content).length;
    const docLength = contentTokenCount || docTokens.length;
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
  const averageDocLength = totalDocLength / filteredRows.length || 1;
  const totalDocs = filteredRows.length;
  const scored = candidates
    .map(({ row, docLength, termFrequency }) => {
      let score = 0;
      for (const token of queryTokens) {
        const tf = termFrequency.get(token) ?? 0;
        if (!tf) continue;
        const df = docFrequencies.get(token) ?? 0;
        if (!df) continue;
        const idf = Math.log1p((totalDocs - df + 0.5) / (df + 0.5));
        const denominator = tf + 1.2 * (1 - 0.75 + 0.75 * (docLength / averageDocLength));
        score += idf * ((tf * (1.2 + 1)) / denominator);
      }
      return { row, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.row.filePath.localeCompare(b.row.filePath) || a.row.chunkIndex - b.row.chunkIndex)
    .slice(0, limit)
    .map(({ row, score }) => ({ ...row, lexicalScore: score, score }));

  return scored;
}

function queryLexicalBm25(
  db: NonNullable<NativeStore['fileSearchDb']>['db'],
  projectKey: string,
  query: string,
  limit: number,
  options: FileSearchIndexSearchOptions | FileSearchIndexFindRelatedOptions = {},
): FileSearchChunkRow[] {
  return queryLexicalBm25Rows(loadAllChunks(db, projectKey), query, limit, options);
}

async function querySemanticSnapshot(
  fileDb: NonNullable<NativeStore['fileSearchDb']>,
  snapshot: HotFileSearchIndexSnapshot,
  query: string,
  limit: number,
  options: FileSearchIndexSearchOptions | FileSearchIndexFindRelatedOptions = {},
): Promise<FileSearchChunkRow[]> {
  if (!fileDb.semanticSearchEnabled || snapshot.vectors.size <= 0) return [];
  const queryVector = await fileDb.embedQuery(query);
  if (!queryVector?.length) return [];
  const queryDimension = queryVector.length;
  const scored: FileSearchChunkRow[] = [];
  for (const row of snapshot.rows.filter((entry) => shouldIncludeRow(entry, options))) {
      const vector = snapshot.vectors.get(chunkKey(row));
      if (!vector || vector.dimension !== queryDimension) continue;
      const semanticScore = cosineSimilarity(queryVector, vector.vector);
      scored.push({
        ...row,
        semanticScore,
        score: semanticScore,
      });
    }
  return scored
    .sort((a, b) => (b.semanticScore ?? 0) - (a.semanticScore ?? 0) || a.filePath.localeCompare(b.filePath) || a.chunkIndex - b.chunkIndex)
    .slice(0, limit);
}

function isSafeFileSearchRow(row: Pick<FileSearchChunkRow, 'filePath' | 'content'>): boolean {
  return !isIgnoredFileSearchArtifact(row.filePath) && !containsSensitiveFileSearchContent(row.content);
}

export function redactSensitiveFileSearchText(text: string): string {
  return containsSensitiveFileSearchContent(text) ? '[redacted sensitive file-search chunk]' : text;
}

function buildHit(row: FileSearchChunkRow, source: FileSearchSearchMode): FileSearchSearchResult {
  return buildSearchResult(row, source, redactSensitiveFileSearchText);
}

function blendHits(
  bm25Rows: FileSearchChunkRow[],
  semanticRows: FileSearchChunkRow[],
  limit: number,
  query: string,
  allRows: FileSearchChunkRow[],
  alpha: number,
): FileSearchChunkRow[] {
  const candidateRows = candidateScoreMap([...bm25Rows, ...semanticRows, ...allRows]);
  const bm25Scores = normalizeRrf(new Map(bm25Rows.map((row) => [chunkKey(row), row.lexicalScore ?? row.score ?? 0])));
  const semanticScores = normalizeRrf(new Map(semanticRows.map((row) => [chunkKey(row), row.semanticScore ?? row.score ?? 0])));
  const combinedScores = new Map<string, number>();

  for (const key of new Set([...bm25Scores.keys(), ...semanticScores.keys()])) {
    combinedScores.set(key, (alpha * (semanticScores.get(key) ?? 0)) + ((1 - alpha) * (bm25Scores.get(key) ?? 0)));
  }

  boostMultiChunkFiles(combinedScores, candidateRows);
  const boostedScores = applyQueryBoost(combinedScores, query, candidateRows);
  const ranked = rerankTopK(boostedScores, candidateRows, limit, alpha < 1.0, query);
  return ranked.map((entry) => ({ ...entry.chunk, score: entry.score }));
}

function findSourceChunk(rows: FileSearchChunkRow[], seed: FileSearchIndexSeed): FileSearchChunkRow | undefined {
  if ('filePath' in seed && 'line' in seed) {
    return rows.find((row) => row.filePath === seed.filePath && row.startLine <= seed.line && row.endLine >= seed.line)
      ?? rows.find((row) => row.filePath === seed.filePath && row.chunkIndex === Math.max(0, seed.line - 1));
  }

  const filePath = 'file' in seed && seed.file?.path ? seed.file.path : 'chunk' in seed && seed.chunk.filePath ? seed.chunk.filePath : 'filePath' in seed ? seed.filePath : undefined;
  const chunkIndex = 'file' in seed ? seed.file?.chunkIndex : 'chunk' in seed ? seed.file?.chunkIndex : 'chunkIndex' in seed ? seed.chunkIndex : undefined;
  const line = 'file' in seed ? seed.file?.startLine ?? seed.file?.endLine : 'chunk' in seed ? seed.chunk.startLine : undefined;

  if (!filePath) return undefined;
  if (typeof chunkIndex === 'number') {
    const byChunk = rows.find((row) => row.filePath === filePath && row.chunkIndex === chunkIndex);
    if (byChunk) return byChunk;
  }
  if (typeof line === 'number') {
    const byLine = rows.find((row) => row.filePath === filePath && row.startLine <= line && row.endLine >= line);
    if (byLine) return byLine;
  }
  return rows.find((row) => row.filePath === filePath);
}

function projectLanguageCounts(rows: FileSearchChunkRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const language = (row.language ?? inferFileSearchLanguage(row.filePath) ?? 'text').toLowerCase();
    counts[language] = (counts[language] ?? 0) + 1;
  }
  return counts;
}

function coldHotIndexStats(overrides: Partial<FileSearchHotIndexStats> = {}): FileSearchHotIndexStats {
  return {
    state: 'cold',
    source: 'none',
    chunkCount: 0,
    vectorCount: 0,
    hydrateCount: 0,
    buildCount: 0,
    revision: 0,
    ...overrides,
  };
}

function emptyStats(identity: FileSearchIndexIdentity, build: FileSearchIndexBuildStats, embedding: FileSearchIndexStats['embedding']): FileSearchIndexStats {
  return {
    index: {
      indexedFiles: 0,
      chunkCount: 0,
      perLanguageCounts: {},
      projectKey: identity.projectKey,
      baseDir: identity.baseDir,
      sourceFingerprint: identity.sourceFingerprint,
      sourceType: identity.sourceType,
      ...(identity.repoUrl ? { repoUrl: identity.repoUrl } : {}),
    },
    build,
    embedding,
    hotIndex: coldHotIndexStats(),
  };
}

export class FileSearchIndexBuilder {
  private constructor(private readonly identity: FileSearchIndexIdentity) {}

  static fromPath(baseDir: string, options: FileSearchIndexBuilderOptions = {}): FileSearchIndexBuilder {
    const resolvedBaseDir = resolve(baseDir);
    return new FileSearchIndexBuilder({
      sourceType: 'path',
      baseDir: resolvedBaseDir,
      projectKey: resolveFileSearchProjectKey(resolvedBaseDir),
      sourceFingerprint: options.sourceFingerprint ?? fingerprintText(resolvedBaseDir),
      ...(options.repoUrl ? { repoUrl: options.repoUrl } : {}),
    });
  }

  static fromGit(repoUrl: string, options: FileSearchIndexBuilderOptions = {}): FileSearchIndexBuilder {
    const resolvedBaseDir = resolve(options.baseDir ?? process.cwd());
    return new FileSearchIndexBuilder({
      sourceType: 'git',
      baseDir: resolvedBaseDir,
      projectKey: resolveFileSearchProjectKey(resolvedBaseDir),
      sourceFingerprint: options.sourceFingerprint ?? fingerprintText(repoUrl),
      repoUrl,
    });
  }

  build(store: NativeStore): FileSearchIndex {
    const startedAt = new Date().toISOString();
    const completedAt = new Date().toISOString();
    const buildStats: FileSearchIndexBuildStats = {
      startedAt,
      completedAt,
      elapsedMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
      projectFingerprint: this.identity.sourceFingerprint,
      backendVersion: BACKEND_VERSION,
    };
    return new FileSearchIndex(store, this.identity, buildStats);
  }
}

const indexCache = new WeakMap<NativeStore, Map<string, FileSearchIndex>>();

function indexCacheKey(identity: FileSearchIndexIdentity): string {
  return [
    identity.sourceType,
    identity.baseDir,
    identity.projectKey,
    identity.sourceFingerprint,
    identity.repoUrl ?? '',
  ].join('\0');
}

function cachedIndex(store: NativeStore, index: FileSearchIndex): FileSearchIndex {
  const key = indexCacheKey(index.identityInfo);
  const cachedByStore = indexCache.get(store);
  const cached = cachedByStore?.get(key);
  if (cached) return cached;
  const nextByStore = cachedByStore ?? new Map<string, FileSearchIndex>();
  nextByStore.set(key, index);
  if (!cachedByStore) indexCache.set(store, nextByStore);
  return index;
}

export class FileSearchIndex {
  private snapshot?: HotFileSearchIndexSnapshot;
  private hotState: FileSearchHotIndexState = 'cold';
  private hydrateCount = 0;
  private buildCount = 0;
  private lastHydratedAt?: string;
  private lastBuiltAt?: string;
  private lastError?: string;
  private lastHydrateMs?: number;

  constructor(
    private readonly store: NativeStore,
    private readonly identity: FileSearchIndexIdentity,
    private readonly buildStats: FileSearchIndexBuildStats,
  ) {}

  static fromPath(store: NativeStore, baseDir: string, options: FileSearchIndexBuilderOptions = {}): FileSearchIndex {
    return cachedIndex(store, FileSearchIndexBuilder.fromPath(baseDir, options).build(store));
  }

  static fromGit(store: NativeStore, repoUrl: string, options: FileSearchIndexBuilderOptions = {}): FileSearchIndex {
    return cachedIndex(store, FileSearchIndexBuilder.fromGit(repoUrl, options).build(store));
  }

  get identityInfo(): FileSearchIndexIdentity {
    return this.identity;
  }

  get buildInfo(): FileSearchIndexBuildStats {
    return this.buildStats;
  }

  private get fileDb() {
    return this.store.fileSearchDb;
  }

  private get projectBaseDir(): string {
    return this.store.fileSearchProjectBaseDir ?? this.store.baseDir;
  }

  private get projectKey(): string {
    return this.identity.projectKey;
  }

  invalidate(reason = 'manual'): void {
    void reason;
    this.snapshot = undefined;
    this.hotState = 'stale';
  }

  get hotIndexInfo(): FileSearchHotIndexStats {
    return this.hotIndexStats();
  }

  private hotIndexStats(): FileSearchHotIndexStats {
    const fileDb = this.fileDb;
    const revision = fileDb?.indexRevision ?? 0;
    const snapshot = this.snapshot;
    const stale = snapshot && snapshot.revision !== revision;
    return {
      state: stale ? 'stale' : this.hotState,
      source: snapshot?.source ?? 'none',
      chunkCount: snapshot?.rows.length ?? 0,
      vectorCount: snapshot?.vectors.size ?? 0,
      hydrateCount: this.hydrateCount,
      buildCount: this.buildCount,
      revision,
      ...(snapshot ? { hydratedRevision: snapshot.revision } : {}),
      ...(this.lastHydratedAt ? { lastHydratedAt: this.lastHydratedAt } : {}),
      ...(this.lastBuiltAt ? { lastBuiltAt: this.lastBuiltAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.lastHydrateMs !== undefined ? { hydrateMs: this.lastHydrateMs } : {}),
      ...(snapshot ? { hydrate: { startedAt: snapshot.hydrateStartedAt, completedAt: snapshot.hydratedAt, elapsedMs: snapshot.hydrateMs } } : {}),
    };
  }

  private currentSnapshot(): HotFileSearchIndexSnapshot | undefined {
    const fileDb = this.fileDb;
    if (!fileDb || !this.snapshot) return undefined;
    if (this.snapshot.revision !== fileDb.indexRevision) {
      this.hotState = 'stale';
      return undefined;
    }
    return this.snapshot;
  }

  hydrate(): HotFileSearchIndexSnapshot | undefined {
    const fileDb = this.fileDb;
    if (!fileDb) return undefined;
    const current = this.currentSnapshot();
    if (current) return current;
    const hydrateStartedAt = new Date().toISOString();
    const startedAt = performance.now();
    this.hotState = 'hydrating';
    try {
      const rows = loadAllChunks(fileDb.db, this.projectKey);
      const vectors = loadReadyEmbeddingVectors(fileDb, this.projectKey);
      const hydrateMs = performance.now() - startedAt;
      const hydratedAt = new Date().toISOString();
      this.snapshot = {
        rows,
        vectors,
        perLanguageCounts: projectLanguageCounts(rows),
        indexedFiles: (fileDb.db.prepare('SELECT COUNT(*) AS count FROM indexed_files WHERE project_key = ?').get(this.projectKey) as { count: number }).count,
        revision: fileDb.indexRevision,
        source: 'sqlite',
        hydrateStartedAt,
        hydratedAt,
        hydrateMs,
      };
      this.hydrateCount += 1;
      this.buildCount += 1;
      this.lastHydratedAt = hydratedAt;
      this.lastBuiltAt = hydratedAt;
      this.lastHydrateMs = hydrateMs;
      this.lastError = undefined;
      this.hotState = 'ready';
      return this.snapshot;
    } catch (error) {
      this.hotState = 'failed';
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  stats(): FileSearchIndexStats {
    const fileDb = this.fileDb;
    if (!fileDb) {
      return emptyStats(this.identity, this.buildStats, {
        enabled: false,
        model: 'unknown',
        providerKey: 'unknown',
        dimension: 0,
        vectorByteSize: 0,
        configuredDimension: 0,
      });
    }

    const embeddingDiagnostics = fileDb.getEmbeddingDiagnostics();
    const snapshot = this.currentSnapshot() ?? this.hydrate();
    return {
      index: {
        indexedFiles: snapshot?.indexedFiles ?? (fileDb.db.prepare('SELECT COUNT(*) AS count FROM indexed_files WHERE project_key = ?').get(this.projectKey) as { count: number }).count,
        chunkCount: snapshot?.rows.length ?? (fileDb.db.prepare('SELECT COUNT(*) AS count FROM indexed_chunks WHERE project_key = ?').get(this.projectKey) as { count: number }).count,
        perLanguageCounts: snapshot?.perLanguageCounts ?? {},
        projectKey: this.projectKey,
        baseDir: this.projectBaseDir,
        sourceFingerprint: this.identity.sourceFingerprint,
        sourceType: this.identity.sourceType,
        ...(this.identity.repoUrl ? { repoUrl: this.identity.repoUrl } : {}),
      },
      build: this.buildStats,
      embedding: {
        enabled: embeddingDiagnostics.enabled,
        model: embeddingDiagnostics.model,
        providerKey: embeddingDiagnostics.providerKey,
        dimension: embeddingDiagnostics.configuredDimension,
        vectorByteSize: embeddingDiagnostics.configuredDimension * 4,
        configuredDimension: embeddingDiagnostics.configuredDimension,
      },
      hotIndex: this.hotIndexStats(),
    };
  }

  async search(query: string, options: FileSearchIndexSearchOptions = {}): Promise<FileSearchSearchResult[]> {
    const fileDb = this.fileDb;
    if (!fileDb) return [];
    const mode = options.mode ?? 'hybrid';
    const limit = Math.max(1, options.topK ?? 10);
    markFileSearchProjectSeen(fileDb.db, this.projectBaseDir, 'manual-search');
    const snapshot = this.hydrate();
    if (!snapshot) return [];
    const overFetch = mode === 'hybrid' ? limit * 5 : limit;
    const lexicalRows = queryLexicalBm25Rows(snapshot.rows, query, overFetch, options);
    const safeLexicalRows = lexicalRows.filter(isSafeFileSearchRow);
    if (mode === 'bm25') return safeLexicalRows.slice(0, limit).map((row) => buildHit(row, 'bm25'));
    if (mode === 'semantic') {
      const semanticRows = await querySemanticSnapshot(fileDb, snapshot, query, overFetch, options);
      return semanticRows.filter(isSafeFileSearchRow).slice(0, limit).map((row) => buildHit(row, 'semantic'));
    }

    const semanticRows = await querySemanticSnapshot(fileDb, snapshot, query, overFetch, options);
    const safeSemanticRows = semanticRows.filter(isSafeFileSearchRow);
    if (!safeSemanticRows.length) return safeLexicalRows.slice(0, limit).map((row) => buildHit(row, 'bm25'));

    const allRows = snapshot.rows.filter((row) => shouldIncludeRow(row, options));
    const alpha = resolveAlpha(query, options.alpha);
    const blended = blendHits(safeLexicalRows, safeSemanticRows, limit, query, allRows, alpha);
    return (blended.length ? blended : safeSemanticRows.slice(0, limit)).map((row) => buildHit(row, 'hybrid'));
  }

  async findRelated(source: FileSearchIndexSeed, options: FileSearchIndexFindRelatedOptions = {}): Promise<FileSearchSearchResult[]> {
    const fileDb = this.fileDb;
    if (!fileDb) return [];
    const topK = Math.max(1, options.topK ?? 5);
    markFileSearchProjectSeen(fileDb.db, this.projectBaseDir, 'manual-search');
    const snapshot = this.hydrate();
    if (!snapshot) return [];
    const allRows = snapshot.rows.filter((row) => shouldIncludeRow(row, options));
    const seed = findSourceChunk(allRows, source);
    if (!seed) return [];

    const seedLanguage = seed.language ?? inferFileSearchLanguage(seed.filePath);
    const candidateCount = Math.max(2, topK * 5);
    const semanticRows = await querySemanticSnapshot(fileDb, snapshot, seed.content, candidateCount, {
      ...options,
      ...(seedLanguage ? { filterLanguages: [...new Set([...(options.filterLanguages ?? []), seedLanguage])] } : {}),
    });
    const safeSemanticRows = semanticRows
      .filter(isSafeFileSearchRow)
      .filter((row) => row.filePath !== seed.filePath || row.chunkIndex !== seed.chunkIndex);
    const filtered = seedLanguage
      ? safeSemanticRows.filter((row) => (row.language ?? inferFileSearchLanguage(row.filePath)) === seedLanguage)
      : safeSemanticRows;
    if (filtered.length) return filtered.slice(0, topK).map((row) => buildHit(row, 'semantic'));

    const fallbackQuery = Array.from(new Set(tokenizeSearchQuery(seed.content))).slice(0, 3).join(' ') || seed.content;
    const fallbackHits = await this.search(fallbackQuery, {
      ...options,
      mode: 'hybrid',
      topK: candidateCount,
      ...(seedLanguage ? { filterLanguages: [...new Set([...(options.filterLanguages ?? []), seedLanguage])] } : {}),
    });
    return fallbackHits
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
      })
      .slice(0, topK);
  }
}

export function buildFileSearchIndex(store: NativeStore, options: FileSearchIndexBuilderOptions = {}): FileSearchIndex {
  const baseDir = options.baseDir ?? store.fileSearchProjectBaseDir ?? store.baseDir;
  return FileSearchIndex.fromPath(store, baseDir, options);
}

export function invalidateFileSearchIndex(store: NativeStore, options: FileSearchIndexBuilderOptions = {}): void {
  const baseDir = options.baseDir ?? store.fileSearchProjectBaseDir ?? store.baseDir;
  const identity = FileSearchIndexBuilder.fromPath(baseDir, options).build(store).identityInfo;
  indexCache.get(store)?.get(indexCacheKey(identity))?.invalidate('store-mutation');
}
