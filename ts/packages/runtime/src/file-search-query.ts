import type { MemoryRecord } from './contracts.js';
import type { NativeStore } from './store.js';
import { normalizeIdentity } from './identity.js';
import { resolveProjectContext } from './project-context.js';

export interface FileSearchQuery {
  query: string;
  scope?: 'project' | 'dir' | 'user' | 'agent';
  limit?: number;
  mode?: 'fts' | 'hybrid';
}

export interface FileSearchHit extends MemoryRecord {
  file?: {
    projectKey: string;
    path: string;
    chunkIndex?: number;
    chunkText?: string;
    chunkHash?: string;
  };
}

function canonicalProjectKey(baseDir: string): string {
  return `project:${resolveProjectContext({}, baseDir).projectKey}`;
}

function tokenize(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function queryFts(db: NonNullable<NativeStore['fileSearchDb']>['db'], projectKey: string, query: string, limit: number) {
  const tokens = tokenize(query);
  if (!tokens.length) return [] as Array<{ project_key: string; path: string; chunk_index: number; chunk_text: string; chunk_hash: string; content_hash: string | null }>;
  const ftsQuery = tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' ');
  return db.prepare(`
    SELECT fr.project_key, fr.path, fc.chunk_index, fc.chunk_text, fc.chunk_hash, fr.content_hash
    FROM indexed_chunks fc
    JOIN file_records fr ON fr.id = fc.file_record_id
    JOIN indexed_chunks_fts ON indexed_chunks_fts.rowid = fc.rowid
    WHERE fr.project_key = ? AND indexed_chunks_fts MATCH ?
    ORDER BY bm25(indexed_chunks_fts), fc.created_at DESC, fc.chunk_index ASC
    LIMIT ?
  `).all(projectKey, ftsQuery, limit) as Array<{ project_key: string; path: string; chunk_index: number; chunk_text: string; chunk_hash: string; content_hash: string | null }>;
}

function buildHit(row: { project_key: string; path: string; chunk_index: number; chunk_text: string; chunk_hash: string }): FileSearchHit {
  return {
    id: `${row.project_key}:${row.path}:${row.chunk_index}`,
    scope: 'project',
    identity: normalizeIdentity('project', { namespace: row.project_key, leafName: row.path, parentContext: `chunk-${row.chunk_index}` }),
    provenance: { source: 'file-search', origin: 'indexed-chunk' },
    content: { text: row.chunk_text },
    metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    file: { projectKey: row.project_key, path: row.path, chunkIndex: row.chunk_index, chunkText: row.chunk_text, chunkHash: row.chunk_hash },
  };
}

export async function searchIndex(store: NativeStore, query: FileSearchQuery): Promise<FileSearchHit[]> {
  const fileDb = store.fileSearchDb;
  if (!fileDb) return [];
  const limit = query.limit ?? 10;
  const projectKey = canonicalProjectKey(store.baseDir);
  const ftsRows = queryFts(fileDb.db, projectKey, query.query, limit);
  const ftsHits = ftsRows.map(buildHit);
  if (query.mode === 'fts' || ftsHits.length > 0) return ftsHits.slice(0, limit);

  return [];
}
