import { createHash } from 'node:crypto';
import type { MemoryRecord, MemoryScope } from './contracts.js';
import type { NativeStore } from './store.js';
import type { MemorySearchMode, SqliteSidecarReader } from './sqlite-sidecar-internal.js';
import { MEMORY_SEARCH_EMBEDDING_IDENTITY_VERSION } from './embedding-client.js';
import { cosineSimilarity, decodeEmbedding, truncateEmbeddingText } from './embedding-vector.js';

export type MemorySearchHotIndexState = 'cold' | 'hydrating' | 'ready' | 'stale' | 'failed';

export interface MemorySearchHotIndexStats {
  state: MemorySearchHotIndexState;
  source: 'none' | 'sqlite';
  recordCount: number;
  vectorCount: number;
  hydrateCount: number;
  buildCount: number;
  revision: number;
  hydratedRevision?: number;
  lastHydratedAt?: string;
  lastBuiltAt?: string;
  lastError?: string;
  hydrateMs?: number;
}

type MemoryIndexedRow = {
  record: MemoryRecord;
  searchText: string;
};

type HotMemoryVector = {
  vector: ArrayLike<number>;
  dimension: number;
  rowIndex?: number;
};

type HotMemoryBm25Row = {
  row: MemoryIndexedRow;
  rowIndex: number;
  key: string;
  docTokens: string[];
  docLength: number;
};

type HotMemoryBm25Index = {
  sourceRows: MemoryIndexedRow[];
  rows: HotMemoryBm25Row[];
  rowByKey: Map<string, number>;
  postings: Map<string, number[]>;
  totalDocLength: number;
  docFrequencies: Map<string, number>;
};

type HotMemoryVectorEntry = {
  row: MemoryIndexedRow;
  rowIndex: number;
  key: string;
  vector: ArrayLike<number>;
  dimension: number;
};

interface HotMemorySearchIndexSnapshot {
  rows: MemoryIndexedRow[];
  vectors: Map<string, HotMemoryVector>;
  bm25: HotMemoryBm25Index;
  vectorEntries: HotMemoryVectorEntry[];
  revision: number;
  source: 'sqlite';
  hydratedAt: string;
  hydrateMs: number;
}

function rowKey(row: MemoryIndexedRow): string {
  return row.record.id;
}

function scopeRank(scope: MemoryScope): number {
  if (scope === 'project') return 0;
  if (scope === 'dir') return 1;
  if (scope === 'user') return 2;
  return 3;
}

function compareRows(a: MemoryIndexedRow, b: MemoryIndexedRow): number {
  return scopeRank(a.record.scope) - scopeRank(b.record.scope) || a.record.id.localeCompare(b.record.id);
}

function tokenize(value: string): string[] {
  return (value.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []).filter(Boolean);
}

function uniqueTokens(value: string): string[] {
  return Array.from(new Set(tokenize(value)));
}

function memoryRecordSearchText(record: MemoryRecord): string {
  return [
    record.id,
    record.scope,
    record.identity.namespace,
    record.identity.leafName,
    record.identity.parentContext ?? '',
    record.provenance.source,
    record.provenance.adapter ?? '',
    record.provenance.origin ?? '',
    record.content.text ?? '',
    JSON.stringify(record.content.structured ?? {}),
  ].join(' ');
}

function memoryRecordEmbeddingText(record: MemoryRecord): string {
  return [record.id, record.identity.namespace, record.identity.leafName, record.identity.parentContext ?? '', record.content.text ?? '', JSON.stringify(record.content.structured ?? {})].join(' ');
}

function memoryRecordContentHash(record: MemoryRecord): string {
  return createHash('sha256').update(truncateEmbeddingText(memoryRecordEmbeddingText(record))).digest('hex');
}

function loadRecord(row: { id: string; scope: string; namespace: string; leaf_name: string; parent_context: string; provenance_source: string; provenance_timestamp: string | null; provenance_adapter: string | null; provenance_origin: string | null; content_text: string | null; content_structured: string | null; created_at: string; updated_at: string }): MemoryRecord {
  return {
    id: row.id,
    scope: row.scope as MemoryScope,
    identity: {
      namespace: row.namespace,
      leafName: row.leaf_name,
      parentContext: row.parent_context,
    },
    provenance: {
      source: row.provenance_source,
      timestamp: row.provenance_timestamp ?? undefined,
      adapter: row.provenance_adapter ?? undefined,
      origin: row.provenance_origin ?? undefined,
    },
    content: {
      text: row.content_text ?? undefined,
      structured: row.content_structured ? JSON.parse(row.content_structured) : undefined,
    },
    metadata: {
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  };
}

function loadAllRows(sidecar: SqliteSidecarReader): MemoryIndexedRow[] {
  const rows = sidecar.db.prepare('SELECT * FROM records ORDER BY id').all() as Array<Parameters<typeof loadRecord>[0]>;
  return rows.map((row) => {
    const record = loadRecord(row);
    return { record, searchText: memoryRecordSearchText(record) };
  });
}

function buildBm25Index(rows: MemoryIndexedRow[]): HotMemoryBm25Index {
  const indexedRows: HotMemoryBm25Row[] = [];
  const rowByKey = new Map<string, number>();
  const postings = new Map<string, number[]>();
  const docFrequencies = new Map<string, number>();
  let totalDocLength = 0;

  rows.forEach((row, rowIndex) => {
    const key = rowKey(row);
    const docTokens = tokenize(row.searchText);
    const docLength = docTokens.length || 1;
    indexedRows.push({ row, rowIndex, key, docTokens, docLength });
    rowByKey.set(key, rowIndex);
    totalDocLength += docLength;
    const seen = new Set<string>();
    for (const token of docTokens) {
      let posting = postings.get(token);
      if (!posting) {
        posting = [];
        postings.set(token, posting);
      }
      if (posting[posting.length - 1] !== rowIndex) posting.push(rowIndex);
      if (!seen.has(token)) {
        seen.add(token);
        docFrequencies.set(token, (docFrequencies.get(token) ?? 0) + 1);
      }
    }
  });

  return { sourceRows: rows, rows: indexedRows, rowByKey, postings, totalDocLength, docFrequencies };
}

function loadReadyVectors(sidecar: SqliteSidecarReader, rowByKey: Map<string, number>): Map<string, HotMemoryVector> {
  const vectors = new Map<string, HotMemoryVector>();
  const rows = sidecar.db.prepare(`
    SELECT r.*, re.embedding, re.dimension, re.text_hash, re.content_hash
    FROM record_embeddings re
    JOIN records r ON r.id = re.record_id
    WHERE re.provider_key = ?
      AND re.model = ?
      AND re.configured_dimension = ?
      AND re.status = 'ready'
      AND re.identity_version = ?
      AND re.content_hash = re.text_hash
      AND (? = 0 OR re.dimension = ?)
  `).all(
    sidecar.embeddingProviderKey,
    sidecar.embeddingModel,
    sidecar.embeddingConfiguredDimension,
    MEMORY_SEARCH_EMBEDDING_IDENTITY_VERSION,
    sidecar.embeddingConfiguredDimension,
    sidecar.embeddingConfiguredDimension,
  ) as Array<Parameters<typeof loadRecord>[0] & { embedding: Buffer; dimension: number; text_hash: string; content_hash: string }>;

  for (const row of rows) {
    const record = loadRecord(row);
    if (row.content_hash !== memoryRecordContentHash(record)) continue;
    const key = record.id;
    vectors.set(key, {
      vector: Float32Array.from(decodeEmbedding(row.embedding, row.dimension)),
      dimension: row.dimension,
      rowIndex: rowByKey.get(key),
    });
  }
  return vectors;
}

function buildVectorEntries(snapshot: HotMemorySearchIndexSnapshot): HotMemoryVectorEntry[] {
  const entries: HotMemoryVectorEntry[] = [];
  for (const [key, vector] of snapshot.vectors.entries()) {
    const rowIndex = snapshot.bm25.rowByKey.get(key) ?? vector.rowIndex;
    if (rowIndex === undefined) continue;
    const row = snapshot.rows[rowIndex];
    if (!row) continue;
    vector.rowIndex = rowIndex;
    entries.push({ row, rowIndex, key, vector: vector.vector, dimension: vector.dimension });
  }
  return entries.sort((a, b) => a.rowIndex - b.rowIndex);
}

function filterRows(rows: MemoryIndexedRow[], scope?: MemoryScope): MemoryIndexedRow[] {
  return scope ? rows.filter((row) => row.record.scope === scope) : rows;
}

function queryBm25(snapshot: HotMemorySearchIndexSnapshot, query: string, limit: number, scope?: MemoryScope): Array<{ row: MemoryIndexedRow; score: number }> {
  const queryTokens = uniqueTokens(query);
  const filteredRows = filterRows(snapshot.rows, scope);
  if (!queryTokens.length) return filteredRows.slice(0, limit).map((row) => ({ row, score: 0 }));
  if (!filteredRows.length) return [];
  const queryTerms = new Set(queryTokens);
  const filteredIndexes = new Set<number>();
  const docFrequencies = new Map<string, number>();
  let totalDocLength = 0;
  for (const row of filteredRows) {
    const rowIndex = snapshot.bm25.rowByKey.get(rowKey(row));
    if (rowIndex === undefined) continue;
    filteredIndexes.add(rowIndex);
    const bm25Row = snapshot.bm25.rows[rowIndex];
    if (!bm25Row) continue;
    totalDocLength += bm25Row.docLength;
    const seen = new Set<string>();
    for (const token of bm25Row.docTokens) {
      if (!queryTerms.has(token) || seen.has(token)) continue;
      seen.add(token);
      docFrequencies.set(token, (docFrequencies.get(token) ?? 0) + 1);
    }
  }

  const candidateIndexes = new Set<number>();
  for (const token of queryTokens) {
    for (const rowIndex of snapshot.bm25.postings.get(token) ?? []) {
      if (filteredIndexes.has(rowIndex)) candidateIndexes.add(rowIndex);
    }
  }
  const averageDocLength = totalDocLength / filteredRows.length || 1;
  return Array.from(candidateIndexes, (rowIndex) => snapshot.bm25.rows[rowIndex])
    .filter((row): row is HotMemoryBm25Row => Boolean(row))
    .map(({ row, docLength, docTokens }) => {
      const termFrequency = new Map<string, number>();
      for (const token of docTokens) {
        if (queryTerms.has(token)) termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
      }
      let score = 0;
      for (const token of queryTokens) {
        const tf = termFrequency.get(token) ?? 0;
        const df = docFrequencies.get(token) ?? 0;
        if (!tf || !df) continue;
        const idf = Math.log1p((filteredRows.length - df + 0.5) / (df + 0.5));
        const denominator = tf + 1.2 * (1 - 0.75 + 0.75 * (docLength / averageDocLength));
        score += idf * ((tf * 2.2) / denominator);
      }
      return { row, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || compareRows(a.row, b.row))
    .slice(0, limit);
}

async function querySemantic(sidecar: SqliteSidecarReader, snapshot: HotMemorySearchIndexSnapshot, query: string, limit: number, scope?: MemoryScope): Promise<Array<{ row: MemoryIndexedRow; score: number }>> {
  if (!sidecar.semanticSearchEnabled || snapshot.vectors.size <= 0) return [];
  const queryVector = await sidecar.embedQuery(query);
  if (!queryVector?.length) return [];
  const includedIndexes = new Set(filterRows(snapshot.rows, scope).map((row) => snapshot.bm25.rowByKey.get(rowKey(row))).filter((value): value is number => value !== undefined));
  return snapshot.vectorEntries
    .filter((entry) => includedIndexes.has(entry.rowIndex) && entry.dimension === queryVector.length)
    .map((entry) => ({ row: entry.row, score: cosineSimilarity(Array.from(queryVector), Array.from(entry.vector)) }))
    .filter((entry) => entry.score >= 0.35)
    .sort((a, b) => b.score - a.score || compareRows(a.row, b.row))
    .slice(0, limit);
}

function normalizeRrf(rows: Array<{ row: MemoryIndexedRow; score: number }>): Map<string, number> {
  const ranked = [...rows].sort((a, b) => b.score - a.score || compareRows(a.row, b.row));
  const scores = new Map<string, number>();
  ranked.forEach((entry, index) => scores.set(entry.row.record.id, 1 / (60 + index + 1)));
  const max = Math.max(...scores.values(), 0);
  if (!max) return scores;
  for (const [key, score] of scores.entries()) scores.set(key, score / max);
  return scores;
}

function mergeHybrid(lexical: Array<{ row: MemoryIndexedRow; score: number }>, semantic: Array<{ row: MemoryIndexedRow; score: number }>, limit: number): MemoryRecord[] {
  const rowsById = new Map<string, MemoryIndexedRow>();
  for (const entry of [...lexical, ...semantic]) rowsById.set(entry.row.record.id, entry.row);
  const lexicalScores = normalizeRrf(lexical);
  const semanticScores = normalizeRrf(semantic);
  return [...rowsById.values()]
    .map((row) => ({
      row,
      score: ((lexicalScores.get(row.record.id) ?? 0) * 0.5) + ((semanticScores.get(row.record.id) ?? 0) * 0.5),
    }))
    .sort((a, b) => b.score - a.score || compareRows(a.row, b.row))
    .slice(0, limit)
    .map((entry) => entry.row.record);
}

const indexCache = new WeakMap<SqliteSidecarReader, MemorySearchIndex>();

export function buildMemorySearchIndexForSidecar(sidecar: SqliteSidecarReader): MemorySearchIndex {
  const cached = indexCache.get(sidecar);
  if (cached) return cached;
  const index = new MemorySearchIndex(sidecar);
  indexCache.set(sidecar, index);
  return index;
}

export function buildMemorySearchIndex(store: Pick<NativeStore, 'sidecar'>): MemorySearchIndex | undefined {
  return store.sidecar ? buildMemorySearchIndexForSidecar(store.sidecar) : undefined;
}

export class MemorySearchIndex {
  private snapshot?: HotMemorySearchIndexSnapshot;
  private hotState: MemorySearchHotIndexState = 'cold';
  private hydrateCount = 0;
  private buildCount = 0;
  private lastHydratedAt?: string;
  private lastBuiltAt?: string;
  private lastError?: string;
  private lastHydrateMs?: number;

  constructor(private readonly sidecar: SqliteSidecarReader) {}

  get hotIndexInfo(): MemorySearchHotIndexStats {
    const revision = this.sidecar.indexRevision;
    const stale = this.snapshot && this.snapshot.revision !== revision;
    return {
      state: stale ? 'stale' : this.hotState,
      source: this.snapshot?.source ?? 'none',
      recordCount: this.snapshot?.rows.length ?? 0,
      vectorCount: this.snapshot?.vectors.size ?? 0,
      hydrateCount: this.hydrateCount,
      buildCount: this.buildCount,
      revision,
      ...(this.snapshot ? { hydratedRevision: this.snapshot.revision } : {}),
      ...(this.lastHydratedAt ? { lastHydratedAt: this.lastHydratedAt } : {}),
      ...(this.lastBuiltAt ? { lastBuiltAt: this.lastBuiltAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.lastHydrateMs !== undefined ? { hydrateMs: this.lastHydrateMs } : {}),
    };
  }

  private currentSnapshot(): HotMemorySearchIndexSnapshot | undefined {
    if (!this.snapshot) return undefined;
    if (this.snapshot.revision !== this.sidecar.indexRevision) {
      this.hotState = 'stale';
      return undefined;
    }
    return this.snapshot;
  }

  hydrate(): HotMemorySearchIndexSnapshot | undefined {
    const current = this.currentSnapshot();
    if (current) return current;
    const startedAt = performance.now();
    this.hotState = 'hydrating';
    try {
      const rows = loadAllRows(this.sidecar);
      const bm25 = buildBm25Index(rows);
      const vectors = loadReadyVectors(this.sidecar, bm25.rowByKey);
      const hydrateMs = performance.now() - startedAt;
      const hydratedAt = new Date().toISOString();
      const snapshot: HotMemorySearchIndexSnapshot = {
        rows,
        vectors,
        bm25,
        vectorEntries: [],
        revision: this.sidecar.indexRevision,
        source: 'sqlite',
        hydratedAt,
        hydrateMs,
      };
      snapshot.vectorEntries = buildVectorEntries(snapshot);
      this.snapshot = snapshot;
      this.hydrateCount += 1;
      this.buildCount += 1;
      this.lastHydratedAt = hydratedAt;
      this.lastBuiltAt = hydratedAt;
      this.lastHydrateMs = hydrateMs;
      this.lastError = undefined;
      this.hotState = 'ready';
      return snapshot;
    } catch (error) {
      this.hotState = 'failed';
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async search(query: string, options: { scope?: MemoryScope; limit?: number; mode?: MemorySearchMode } = {}): Promise<MemoryRecord[]> {
    const mode = options.mode ?? 'hybrid';
    const limit = Math.max(1, options.limit ?? 10);
    const snapshot = this.hydrate();
    if (!snapshot) return [];
    const overFetch = mode === 'hybrid' ? limit * 5 : limit;
    const lexical = queryBm25(snapshot, query, overFetch, options.scope);
    if (mode === 'bm25') return lexical.slice(0, limit).map((entry) => entry.row.record);
    const semantic = await querySemantic(this.sidecar, snapshot, query, overFetch, options.scope);
    if (mode === 'semantic') return semantic.slice(0, limit).map((entry) => entry.row.record);
    if (!semantic.length) return lexical.slice(0, limit).map((entry) => entry.row.record);
    return mergeHybrid(lexical, semantic, limit);
  }
}
