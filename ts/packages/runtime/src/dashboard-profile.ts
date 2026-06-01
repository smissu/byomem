import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { openGraphDb, resolveDefaultGraphDbPath, type GraphStatus } from './graph-db.js';
import { resolveDefaultFileSearchDbPath, resolveFileSearchProjectKey } from './file-search-db.js';

export type DashboardProfileEvidenceState = 'ready' | 'degraded' | 'missing' | 'unavailable' | 'not-collected';
export type DashboardProfileEvidenceSource = 'db-read-only' | 'injected' | 'missing' | 'not-collected' | 'unavailable';
export type DashboardEmbeddingReadiness = 'ready' | 'refresh-needed' | 'disabled' | 'incompatible' | 'missing' | 'unavailable' | 'not-collected';

export type DashboardFileSearchProfile = {
  state: DashboardProfileEvidenceState;
  source: DashboardProfileEvidenceSource;
  evidenceTier: 'db-read-only' | 'not-collected';
  dbPath: string;
  indexedFileCount: number | null;
  chunkCount: number | null;
  lastIndexedAt: string | null;
  languageCounts: Record<string, number>;
  summary: string;
  warnings: string[];
};

export type DashboardGraphProfile = {
  state: DashboardProfileEvidenceState;
  source: DashboardProfileEvidenceSource;
  evidenceTier: 'db-read-only' | 'not-collected';
  dbPath: string;
  nodeCount: number | null;
  edgeCount: number | null;
  communityCount: number | null;
  relationCounts: Record<string, number>;
  lastUpdateSource: string | null;
  lastImportTimestamp: string | null;
  summary: string;
  warnings: string[];
};

export type DashboardEmbeddingProfile = {
  state: DashboardProfileEvidenceState;
  source: DashboardProfileEvidenceSource;
  evidenceTier: 'db-read-only' | 'not-collected';
  readiness: DashboardEmbeddingReadiness;
  model: string | null;
  providerKey: string | null;
  embeddedChunkCount: number | null;
  missingChunkCount: number | null;
  failedChunkCount: number | null;
  dimensions: Array<{ dimension: number; chunks: number }>;
  summary: string;
  warnings: string[];
};

export type DashboardProfileSummary = {
  projectBaseDir: string;
  runtimeBaseDir: string;
  collectedAt: string;
  fileSearch: DashboardFileSearchProfile;
  graph: DashboardGraphProfile;
  embedding: DashboardEmbeddingProfile;
};

export type CollectDashboardProfileSummaryOptions = {
  projectBaseDir: string;
  runtimeBaseDir: string;
  collectedAt?: Date | string;
  fileSearchDbPath?: string;
  graphDbPath?: string;
  injected?: Partial<Pick<DashboardProfileSummary, 'fileSearch' | 'graph' | 'embedding'>>;
};

const MAX_LANGUAGE_COUNTS = 16;
const MAX_EMBEDDING_DIMENSIONS = 8;
const NOT_COLLECTED_SUMMARY = 'Not collected by static dashboard generation.';

function normalizeCollectedAt(value: Date | string | undefined): string {
  if (value === undefined) return new Date().toISOString();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new Error('collectedAt must be a valid date');
    return parsed.toISOString();
  }
  return value.toISOString();
}

function countRow(db: BetterSqliteDatabase, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

function tableExists(db: BetterSqliteDatabase, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?").get(table) as { name?: string } | undefined;
  return Boolean(row?.name);
}

function missingFileSearchProfile(dbPath: string): DashboardFileSearchProfile {
  return {
    state: 'missing',
    source: 'missing',
    evidenceTier: 'not-collected',
    dbPath,
    indexedFileCount: null,
    chunkCount: null,
    lastIndexedAt: null,
    languageCounts: {},
    summary: 'File-search database is missing; no profile evidence was collected.',
    warnings: [],
  };
}

function missingEmbeddingProfile(): DashboardEmbeddingProfile {
  return {
    state: 'missing',
    source: 'missing',
    evidenceTier: 'not-collected',
    readiness: 'missing',
    model: null,
    providerKey: null,
    embeddedChunkCount: null,
    missingChunkCount: null,
    failedChunkCount: null,
    dimensions: [],
    summary: 'File-search database is missing; embedding readiness was not collected.',
    warnings: [],
  };
}

function missingGraphProfile(dbPath: string): DashboardGraphProfile {
  return {
    state: 'missing',
    source: 'missing',
    evidenceTier: 'not-collected',
    dbPath,
    nodeCount: null,
    edgeCount: null,
    communityCount: null,
    relationCounts: {},
    lastUpdateSource: null,
    lastImportTimestamp: null,
    summary: 'Graph database is missing; no profile evidence was collected.',
    warnings: [],
  };
}

function unavailableFileSearchProfile(dbPath: string, reason: string): DashboardFileSearchProfile {
  return {
    state: 'not-collected',
    source: 'not-collected',
    evidenceTier: 'not-collected',
    dbPath,
    indexedFileCount: null,
    chunkCount: null,
    lastIndexedAt: null,
    languageCounts: {},
    summary: NOT_COLLECTED_SUMMARY,
    warnings: [reason],
  };
}

function unavailableEmbeddingProfile(reason: string): DashboardEmbeddingProfile {
  return {
    state: 'not-collected',
    source: 'not-collected',
    evidenceTier: 'not-collected',
    readiness: 'not-collected',
    model: null,
    providerKey: null,
    embeddedChunkCount: null,
    missingChunkCount: null,
    failedChunkCount: null,
    dimensions: [],
    summary: NOT_COLLECTED_SUMMARY,
    warnings: [reason],
  };
}

function unavailableGraphProfile(dbPath: string, reason: string): DashboardGraphProfile {
  return {
    state: 'unavailable',
    source: 'unavailable',
    evidenceTier: 'not-collected',
    dbPath,
    nodeCount: null,
    edgeCount: null,
    communityCount: null,
    relationCounts: {},
    lastUpdateSource: null,
    lastImportTimestamp: null,
    summary: 'Graph profile evidence was unavailable through the read-only collector.',
    warnings: [reason],
  };
}

function inferLanguage(path: string): string {
  const ext = extname(path).toLowerCase();
  switch (ext) {
    case '.ts':
    case '.tsx':
      return 'TypeScript';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'JavaScript';
    case '.json':
      return 'JSON';
    case '.md':
    case '.mdx':
      return 'Markdown';
    case '.py':
      return 'Python';
    case '.rs':
      return 'Rust';
    case '.go':
      return 'Go';
    case '.java':
      return 'Java';
    case '.css':
      return 'CSS';
    case '.html':
    case '.htm':
      return 'HTML';
    case '.yml':
    case '.yaml':
      return 'YAML';
    case '.toml':
      return 'TOML';
    case '.sql':
      return 'SQL';
    case '.sh':
    case '.bash':
    case '.zsh':
      return 'Shell';
    default:
      return ext ? ext.slice(1).toUpperCase() : 'Other';
  }
}

function boundLanguageCounts(paths: string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const language = inferLanguage(path);
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const bounded = sorted.slice(0, MAX_LANGUAGE_COUNTS);
  const overflow = sorted.slice(MAX_LANGUAGE_COUNTS).reduce((sum, [, count]) => sum + count, 0);
  return Object.fromEntries(overflow > 0 ? [...bounded, ['Other', (bounded.find(([name]) => name === 'Other')?.[1] ?? 0) + overflow]] : bounded);
}

function collectFileSearchAndEmbedding(options: CollectDashboardProfileSummaryOptions): {
  fileSearch: DashboardFileSearchProfile;
  embedding: DashboardEmbeddingProfile;
} {
  const projectBaseDir = resolve(options.projectBaseDir);
  const dbPath = resolve(options.fileSearchDbPath ?? resolveDefaultFileSearchDbPath({ dbBaseDir: options.runtimeBaseDir }));
  if (!existsSync(dbPath)) {
    return { fileSearch: missingFileSearchProfile(dbPath), embedding: missingEmbeddingProfile() };
  }

  let db: BetterSqliteDatabase | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    if (!tableExists(db, 'indexed_files') || !tableExists(db, 'indexed_chunks')) {
      const reason = 'File-search database does not expose the indexed_files/indexed_chunks read-only schema.';
      return { fileSearch: unavailableFileSearchProfile(dbPath, reason), embedding: unavailableEmbeddingProfile(reason) };
    }

    const projectKey = resolveFileSearchProjectKey(projectBaseDir);
    const indexedFileCount = countRow(db, 'SELECT COUNT(*) AS count FROM indexed_files WHERE project_key = ?', projectKey);
    const chunkCount = countRow(db, 'SELECT COUNT(*) AS count FROM indexed_chunks WHERE project_key = ?', projectKey);
    const paths = db.prepare('SELECT path FROM indexed_files WHERE project_key = ? ORDER BY path ASC').all(projectKey) as Array<{ path: string }>;
    const scannerStatus = tableExists(db, 'file_search_scanner_status')
      ? db.prepare('SELECT completed_at AS completedAt, updated_at AS updatedAt FROM file_search_scanner_status WHERE project_key = ?').get(projectKey) as { completedAt?: string | null; updatedAt?: string | null } | undefined
      : undefined;
    const fileSearch: DashboardFileSearchProfile = {
      state: 'ready',
      source: 'db-read-only',
      evidenceTier: 'db-read-only',
      dbPath,
      indexedFileCount,
      chunkCount,
      lastIndexedAt: scannerStatus?.completedAt ?? scannerStatus?.updatedAt ?? null,
      languageCounts: boundLanguageCounts(paths.map((row) => row.path)),
      summary: `${indexedFileCount} indexed file${indexedFileCount === 1 ? '' : 's'} and ${chunkCount} chunk${chunkCount === 1 ? '' : 's'} collected from a read-only SQLite connection.`,
      warnings: [],
    };

    if (!tableExists(db, 'indexed_chunk_embeddings')) {
      return {
        fileSearch,
        embedding: unavailableEmbeddingProfile('File-search database does not expose the indexed_chunk_embeddings read-only schema.'),
      };
    }

    const embeddedChunkCount = countRow(db, "SELECT COUNT(*) AS count FROM indexed_chunk_embeddings WHERE project_key = ? AND status = 'ready'", projectKey);
    const failedChunkCount = countRow(db, "SELECT COUNT(*) AS count FROM indexed_chunk_embeddings WHERE project_key = ? AND status = 'failed'", projectKey);
    const missingChunkCount = countRow(db, `
      SELECT COUNT(*) AS count
      FROM indexed_chunks c
      WHERE c.project_key = ? AND NOT EXISTS (SELECT 1 FROM indexed_chunk_embeddings e WHERE e.chunk_id = c.id)
    `, projectKey);
    const identity = db.prepare(`
      SELECT model, provider_key AS providerKey, COUNT(*) AS count
      FROM indexed_chunk_embeddings
      WHERE project_key = ?
      GROUP BY model, provider_key
      ORDER BY count DESC, model ASC
      LIMIT 1
    `).get(projectKey) as { model?: string; providerKey?: string | null } | undefined;
    const dimensions = db.prepare(`
      SELECT dimension, COUNT(*) AS chunks
      FROM indexed_chunk_embeddings
      WHERE project_key = ? AND status = 'ready'
      GROUP BY dimension
      ORDER BY chunks DESC, dimension ASC
      LIMIT ?
    `).all(projectKey, MAX_EMBEDDING_DIMENSIONS) as Array<{ dimension: number; chunks: number }>;
    const readiness: DashboardEmbeddingReadiness = chunkCount === 0
      ? 'not-collected'
      : failedChunkCount > 0
        ? 'refresh-needed'
        : missingChunkCount > 0
          ? 'refresh-needed'
          : embeddedChunkCount >= chunkCount
            ? 'ready'
            : 'refresh-needed';
    return {
      fileSearch,
      embedding: {
        state: readiness === 'ready' ? 'ready' : 'degraded',
        source: 'db-read-only',
        evidenceTier: 'db-read-only',
        readiness,
        model: identity?.model ?? null,
        providerKey: identity?.providerKey ?? null,
        embeddedChunkCount,
        missingChunkCount,
        failedChunkCount,
        dimensions,
        summary: readiness === 'ready'
          ? 'Embedding readiness is current for indexed chunks in the read-only profile snapshot.'
          : 'Embedding readiness needs review based on read-only indexed chunk evidence.',
        warnings: readiness === 'ready' ? [] : ['Some indexed chunks are missing current ready embeddings.'],
      },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { fileSearch: unavailableFileSearchProfile(dbPath, reason), embedding: unavailableEmbeddingProfile(reason) };
  } finally {
    db?.close();
  }
}

function graphProfileFromStatus(status: GraphStatus): DashboardGraphProfile {
  return {
    state: 'ready',
    source: 'db-read-only',
    evidenceTier: 'db-read-only',
    dbPath: status.dbPath,
    nodeCount: status.nodeCount,
    edgeCount: status.edgeCount,
    communityCount: status.reportCommunityCount,
    relationCounts: status.relationCounts,
    lastUpdateSource: status.lastImport?.source ?? null,
    lastImportTimestamp: status.lastImport?.importedAt ?? null,
    summary: `${status.nodeCount} graph node${status.nodeCount === 1 ? '' : 's'} and ${status.edgeCount} edge${status.edgeCount === 1 ? '' : 's'} collected from a read-only SQLite connection.`,
    warnings: [],
  };
}

function collectGraph(options: CollectDashboardProfileSummaryOptions): DashboardGraphProfile {
  const dbPath = resolve(options.graphDbPath ?? resolveDefaultGraphDbPath({ dbBaseDir: options.runtimeBaseDir }));
  if (!existsSync(dbPath)) return missingGraphProfile(dbPath);

  let graph: ReturnType<typeof openGraphDb> | undefined;
  try {
    graph = openGraphDb({ baseDir: options.projectBaseDir, dbBaseDir: options.runtimeBaseDir, dbFile: dbPath, readonly: true });
    return graphProfileFromStatus(graph.status());
  } catch (error) {
    return unavailableGraphProfile(dbPath, error instanceof Error ? error.message : String(error));
  } finally {
    graph?.close();
  }
}

export function buildNotCollectedDashboardProfileSummary(options: Pick<CollectDashboardProfileSummaryOptions, 'projectBaseDir' | 'runtimeBaseDir' | 'collectedAt'>): DashboardProfileSummary {
  const fileSearchDbPath = resolveDefaultFileSearchDbPath({ dbBaseDir: options.runtimeBaseDir });
  const graphDbPath = resolveDefaultGraphDbPath({ dbBaseDir: options.runtimeBaseDir });
  return {
    projectBaseDir: resolve(options.projectBaseDir),
    runtimeBaseDir: resolve(options.runtimeBaseDir),
    collectedAt: normalizeCollectedAt(options.collectedAt),
    fileSearch: missingFileSearchProfile(fileSearchDbPath),
    graph: missingGraphProfile(graphDbPath),
    embedding: missingEmbeddingProfile(),
  };
}

export function collectDashboardProfileSummary(options: CollectDashboardProfileSummaryOptions): DashboardProfileSummary {
  const collectedAt = normalizeCollectedAt(options.collectedAt);
  const collected = collectFileSearchAndEmbedding(options);
  const graph = collectGraph(options);
  return {
    projectBaseDir: resolve(options.projectBaseDir),
    runtimeBaseDir: resolve(options.runtimeBaseDir),
    collectedAt,
    fileSearch: options.injected?.fileSearch ?? collected.fileSearch,
    graph: options.injected?.graph ?? graph,
    embedding: options.injected?.embedding ?? collected.embedding,
  };
}
