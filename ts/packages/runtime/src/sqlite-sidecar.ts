import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import type { MemoryRecord, MemoryScope, WriteIntent } from './contracts.js';
import { normalizeIdentity, normalizeStableKey } from './identity.js';
import { normalizeRecord, normalizeWriteIntent } from './normalizers.js';
import { openEmbeddingClient, type EmbeddingClient } from './embedding-client.js';

export interface SqliteSidecarOptions {
  baseDir: string;
  dbFile?: string;
  embeddingBaseUrl?: string;
  embeddingModel?: string;
  embeddingDimension?: number;
  embeddingTimeoutMs?: number;
  embeddingRequireRemote?: boolean;
}

export interface SqliteSidecar {
  syncWrite(intent: WriteIntent): Promise<MemoryRecord>;
  syncPrune(id: string): MemoryRecord | undefined;
  read(id: string): MemoryRecord | undefined;
  list(): MemoryRecord[];
  search(query: string, scope?: MemoryScope, limit?: number): Promise<MemoryRecord[]>;
  close(): void;
  path: string;
  db: BetterSqliteDatabase;
}

const DEFAULT_DIMENSION = 1536;
export const EMBEDDING_TEXT_MAX_CHARS = 4000;
const EMBEDDING_TEXT_TRUNCATION_MARKER = ' …[truncated for embedding]… ';

function resolveDbPath(options: SqliteSidecarOptions): string {
  return resolve(options.baseDir, options.dbFile ?? 'byomem-index.sqlite');
}

function ensureSchema(db: BetterSqliteDatabase): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      namespace TEXT NOT NULL,
      leaf_name TEXT NOT NULL,
      parent_context TEXT NOT NULL DEFAULT 'root',
      provenance_source TEXT NOT NULL,
      provenance_timestamp TEXT,
      provenance_adapter TEXT,
      provenance_origin TEXT,
      content_text TEXT,
      content_structured TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(id UNINDEXED, scope UNINDEXED, namespace, leaf_name, parent_context, content_text, content_structured, tokenize = 'unicode61');
    CREATE TABLE IF NOT EXISTS embedding_cache (text_hash TEXT PRIMARY KEY, embedding BLOB NOT NULL, model TEXT NOT NULL, dimension INTEGER NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS record_embeddings (record_id TEXT PRIMARY KEY, text_hash TEXT NOT NULL, embedding BLOB NOT NULL, model TEXT NOT NULL, dimension INTEGER NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY(record_id) REFERENCES records(id) ON DELETE CASCADE);
  `);
}

function recordText(record: MemoryRecord): string {
  return [record.id, record.identity.namespace, record.identity.leafName, record.identity.parentContext ?? '', record.content.text ?? '', JSON.stringify(record.content.structured ?? {})].join(' ');
}

function truncateEmbeddingText(text: string, maxChars = EMBEDDING_TEXT_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  const budget = Math.max(0, maxChars - EMBEDDING_TEXT_TRUNCATION_MARKER.length);
  const head = Math.ceil(budget * 0.7);
  const tail = Math.max(0, budget - head);
  return `${text.slice(0, head)}${EMBEDDING_TEXT_TRUNCATION_MARKER}${tail > 0 ? text.slice(-tail) : ''}`;
}

function normalizeFtsQuery(query: string): string {
  const tokens = query.trim().split(/\s+/).map((token) => token.trim()).filter(Boolean);
  if (!tokens.length) return '';
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' ');
}

function encodeEmbedding(embedding: number[]): Buffer {
  const buffer = Buffer.allocUnsafe(embedding.length * 4);
  for (let i = 0; i < embedding.length; i += 1) buffer.writeFloatLE(embedding[i] ?? 0, i * 4);
  return buffer;
}

function decodeEmbedding(blob: Buffer, dimension: number): number[] {
  const vector = new Array<number>(dimension).fill(0);
  for (let i = 0; i < Math.min(dimension, Math.floor(blob.length / 4)); i += 1) vector[i] = blob.readFloatLE(i * 4);
  return vector;
}

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }
  if (!magA || !magB) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function loadRecord(row: { id: string; scope: string; namespace: string; leaf_name: string; parent_context: string; provenance_source: string; provenance_timestamp: string | null; provenance_adapter: string | null; provenance_origin: string | null; content_text: string | null; content_structured: string | null; created_at: string; updated_at: string }): MemoryRecord {
  return normalizeRecord({
    id: row.id,
    scope: row.scope as MemoryRecord['scope'],
    identity: normalizeIdentity(row.scope as MemoryRecord['scope'], { namespace: row.namespace, leafName: row.leaf_name, parentContext: row.parent_context }),
    provenance: { source: row.provenance_source, timestamp: row.provenance_timestamp ?? undefined, adapter: row.provenance_adapter ?? undefined, origin: row.provenance_origin ?? undefined },
    content: { text: row.content_text ?? undefined, structured: row.content_structured ? JSON.parse(row.content_structured) : undefined },
    metadata: { createdAt: row.created_at, updatedAt: row.updated_at },
  });
}

export function openSqliteSidecar(options: SqliteSidecarOptions): SqliteSidecar {
  const filePath = resolveDbPath(options);
  mkdirSync(dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  const embeddingClient: EmbeddingClient = openEmbeddingClient({
    baseUrl: options.embeddingBaseUrl,
    model: options.embeddingModel,
    dimension: options.embeddingDimension ?? DEFAULT_DIMENSION,
    timeoutMs: options.embeddingTimeoutMs,
    requireRemote: options.embeddingRequireRemote,
  });
  ensureSchema(db);
  const selectRecord = db.prepare(`SELECT * FROM records WHERE id = ?`);
  const listRecordsStmt = db.prepare(`SELECT * FROM records ORDER BY id`);
  const searchStmt = db.prepare(`SELECT r.* FROM records_fts f JOIN records r ON r.id = f.id WHERE records_fts MATCH ? AND (? IS NULL OR r.scope = ?) ORDER BY bm25(records_fts) LIMIT ?`);
  const semanticCandidatesStmt = db.prepare(`SELECT r.*, re.embedding, re.dimension FROM record_embeddings re JOIN records r ON r.id = re.record_id WHERE (? IS NULL OR r.scope = ?)`);
  const upsertRecordStmt = db.prepare(`INSERT INTO records (id, scope, namespace, leaf_name, parent_context, provenance_source, provenance_timestamp, provenance_adapter, provenance_origin, content_text, content_structured, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET scope = excluded.scope, namespace = excluded.namespace, leaf_name = excluded.leaf_name, parent_context = excluded.parent_context, provenance_source = excluded.provenance_source, provenance_timestamp = excluded.provenance_timestamp, provenance_adapter = excluded.provenance_adapter, provenance_origin = excluded.provenance_origin, content_text = excluded.content_text, content_structured = excluded.content_structured, updated_at = excluded.updated_at`);
  const deleteFtsStmt = db.prepare(`DELETE FROM records_fts WHERE id = ?`);
  const deleteEmbeddingStmt = db.prepare(`DELETE FROM record_embeddings WHERE record_id = ?`);
  const deleteRecordStmt = db.prepare(`DELETE FROM records WHERE id = ?`);
  const cacheSelectStmt = db.prepare(`SELECT embedding, model, dimension FROM embedding_cache WHERE text_hash = ?`);
  const cacheUpsertStmt = db.prepare(`INSERT OR REPLACE INTO embedding_cache (text_hash, embedding, model, dimension, updated_at) VALUES (?, ?, ?, ?, ?) `);
  const recordEmbeddingUpsertStmt = db.prepare(`INSERT OR REPLACE INTO record_embeddings (record_id, text_hash, embedding, model, dimension, updated_at) VALUES (?, ?, ?, ?, ?, ?) `);
  const upsertFtsStmt = db.prepare(`INSERT INTO records_fts (id, scope, namespace, leaf_name, parent_context, content_text, content_structured) VALUES (?, ?, ?, ?, ?, ?, ?)`);

  async function resolveEmbeddingData(text: string): Promise<{ textHash: string; embedding: Buffer; model: string; dimension: number; updatedAt: string; cacheMiss: boolean } | undefined> {
    const embeddingText = truncateEmbeddingText(text);
    const textHash = embeddingClient.hashText(embeddingText);
    const cached = cacheSelectStmt.get(textHash) as { embedding: Buffer; model: string; dimension: number } | undefined;
    const now = new Date().toISOString();
    if (cached) {
      const vector = decodeEmbedding(cached.embedding, cached.dimension);
      if (!vector.length) return undefined;
      return { textHash, embedding: cached.embedding, model: cached.model, dimension: cached.dimension, updatedAt: now, cacheMiss: false };
    }
    const vector = await embeddingClient.embed(embeddingText);
    if (!vector?.length) return undefined;
    return {
      textHash,
      embedding: encodeEmbedding(vector),
      model: options.embeddingModel ?? 'nomic-embed-text',
      dimension: vector.length,
      updatedAt: now,
      cacheMiss: true,
    };
  }

  function semanticQueryVector(query: string): Promise<number[] | undefined> {
    return embeddingClient.embed(truncateEmbeddingText(query));
  }

  function lexicalMatches(rows: Array<{ id: string; scope: string; namespace: string; leaf_name: string; parent_context: string; provenance_source: string; provenance_timestamp: string | null; provenance_adapter: string | null; provenance_origin: string | null; content_text: string | null; content_structured: string | null; created_at: string; updated_at: string }>, query: string): MemoryRecord[] {
    const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return rows
      .map(loadRecord)
      .filter((record) => {
        if (!tokens.length) return true;
        const haystack = [record.id, record.identity.namespace, record.identity.leafName, record.identity.parentContext ?? '', record.content.text ?? '', JSON.stringify(record.content.structured ?? {})].join(' ').toLowerCase();
        const tokenHits = tokens.filter((token) => haystack.includes(token)).length;
        return tokenHits >= Math.max(1, Math.ceil(tokens.length / 2));
      });
  }

  async function semanticSearch(query: string, scope: MemoryScope, limit: number): Promise<Array<{ record: MemoryRecord; score: number }>> {
    const queryVector = await semanticQueryVector(query);
    if (!queryVector?.length) return [];
    const rows = semanticCandidatesStmt.all(scope ?? null, scope ?? null) as Array<{ id: string; scope: string; namespace: string; leaf_name: string; parent_context: string; provenance_source: string; provenance_timestamp: string | null; provenance_adapter: string | null; provenance_origin: string | null; content_text: string | null; content_structured: string | null; created_at: string; updated_at: string; embedding: Buffer; dimension: number }>;
    return rows
      .map((row) => ({ record: loadRecord(row), score: cosineSimilarity(queryVector, decodeEmbedding(row.embedding, row.dimension)) }))
      .filter((entry) => entry.score >= 0.35)
      .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))
      .slice(0, limit);
  }

  async function hybridSearch(query: string, scope: MemoryScope, limit: number): Promise<MemoryRecord[]> {
    const normalizedQuery = query.trim().toLowerCase();
    const ftsQuery = normalizeFtsQuery(query);
    const lexicalRows = ftsQuery
      ? searchStmt.all(ftsQuery, scope ?? null, scope ?? null, limit * 4) as Array<{ id: string; scope: string; namespace: string; leaf_name: string; parent_context: string; provenance_source: string; provenance_timestamp: string | null; provenance_adapter: string | null; provenance_origin: string | null; content_text: string | null; content_structured: string | null; created_at: string; updated_at: string }>
      : [];
    const lexical = lexicalMatches(lexicalRows, query);

    const lexicalRanked = lexical
      .map((record) => {
        const haystack = [record.id, record.identity.namespace, record.identity.leafName, record.identity.parentContext ?? '', record.content.text ?? '', JSON.stringify(record.content.structured ?? {})].join(' ').toLowerCase();
        const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
        const tokenHits = tokens.filter((token) => haystack.includes(token)).length;
        const lexicalScore = tokens.length ? (tokenHits / tokens.length) : 0;
        return { record, score: lexicalScore };
      })
      .filter((entry) => entry.score >= 0.5)
      .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))
      .slice(0, limit);

    if (lexicalRanked.length) {
      const semantic = await semanticSearch(query, scope, limit * 4);
      const semanticById = new Map(semantic.map((entry) => [entry.record.id, entry.score]));
      return lexicalRanked
        .map((entry) => ({
          record: entry.record,
          score: Math.min(1, (entry.score * 0.6) + ((semanticById.get(entry.record.id) ?? 0) * 0.4)),
        }))
        .filter((entry) => entry.score >= 0.35)
        .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))
        .slice(0, limit)
        .map((entry) => entry.record);
    }

    const semantic = await semanticSearch(query, scope, limit * 4);
    return semantic.filter((entry) => entry.score >= 0.5).slice(0, limit).map((entry) => entry.record);
  }

  return {
    path: filePath,
    db,
    async syncWrite(intent: WriteIntent): Promise<MemoryRecord> {
      const normalized = normalizeWriteIntent(intent);
      const id = normalizeStableKey(normalized.scope, normalized.identity);
      const record = normalizeRecord({
        id,
        scope: normalized.scope,
        provenance: normalized.provenance ?? { source: 'native-store' },
        identity: normalizeIdentity(normalized.scope, normalized.identity),
        content: normalized.content,
        metadata: { createdAt: (selectRecord.get(id) as { created_at: string } | undefined)?.created_at ?? new Date().toISOString(), updatedAt: new Date().toISOString() },
      });
      const text = recordText(record);
      const embedding = await resolveEmbeddingData(text);
      db.transaction(() => {
        upsertRecordStmt.run(record.id, record.scope, record.identity.namespace, record.identity.leafName, record.identity.parentContext ?? 'root', record.provenance.source, record.provenance.timestamp ?? null, record.provenance.adapter ?? null, record.provenance.origin ?? null, record.content.text ?? null, JSON.stringify(record.content.structured ?? {}), record.metadata?.createdAt ?? new Date().toISOString(), record.metadata?.updatedAt ?? new Date().toISOString());
        deleteFtsStmt.run(record.id);
        upsertFtsStmt.run(record.id, record.scope, record.identity.namespace, record.identity.leafName, record.identity.parentContext ?? 'root', record.content.text ?? '', JSON.stringify(record.content.structured ?? {}));
        if (embedding) {
          if (embedding.cacheMiss) cacheUpsertStmt.run(embedding.textHash, embedding.embedding, embedding.model, embedding.dimension, embedding.updatedAt);
          recordEmbeddingUpsertStmt.run(record.id, embedding.textHash, embedding.embedding, embedding.model, embedding.dimension, embedding.updatedAt);
        }
      })();
      return record;
    },
    syncPrune(id: string): MemoryRecord | undefined {
      const removed = this.read(id);
      if (!removed) return undefined;
      db.transaction(() => {
        deleteEmbeddingStmt.run(id);
        deleteFtsStmt.run(id);
        deleteRecordStmt.run(id);
      })();
      return removed;
    },
    read(id: string): MemoryRecord | undefined {
      const row = selectRecord.get(id) as ReturnType<typeof loadRecord> | undefined;
      return row ? loadRecord(row as never) : undefined;
    },
    list(): MemoryRecord[] {
      return (listRecordsStmt.all() as ReturnType<typeof loadRecord>[]).map((row) => loadRecord(row as never));
    },
    async search(query: string, scope?: MemoryScope, limit = 10): Promise<MemoryRecord[]> {
      const narrowedScope = scope ?? 'project';
      const hybridResults = await hybridSearch(query, narrowedScope, limit);
      if (hybridResults.length) return hybridResults;
      const ftsQuery = normalizeFtsQuery(query);
      if (!ftsQuery) return [];
      return (searchStmt.all(ftsQuery, narrowedScope ?? null, narrowedScope ?? null, limit) as ReturnType<typeof loadRecord>[]).map((row) => loadRecord(row as never));
    },
    close(): void {
      db.close();
    },
  };
}
