import type { MemoryRecord, MemoryScope } from './contracts.js';
import type { NativeStore } from './store.js';
import { rankRecords, type SearchMode } from './ranking.js';
import { buildMemorySearchIndex } from './memory-search-index.js';
import type { MemorySearchMode } from './sqlite-sidecar-internal.js';

export interface SearchQuery {
  query: string;
  scope?: MemoryScope;
  mode?: SearchMode | MemorySearchMode;
  limit?: number;
}

function normalizeMemorySearchMode(mode: SearchQuery['mode']): MemorySearchMode {
  if (mode === undefined) return 'hybrid';
  if (mode === 'bm25' || mode === 'semantic' || mode === 'hybrid') return mode;
  throw new Error('Memory search mode must be bm25, semantic, or hybrid');
}

export async function searchIndex(store: NativeStore, query: SearchQuery): Promise<MemoryRecord[]> {
  const limit = query.limit ?? 10;
  const mode = normalizeMemorySearchMode(query.mode);
  const fallbackMode: SearchMode = mode === 'bm25' ? 'lexical' : mode;
  const memoryIndex = buildMemorySearchIndex(store);
  const sidecarResults = memoryIndex ? await memoryIndex.search(query.query, { scope: query.scope, limit, mode }) : [];
  const records = store.list().filter((record) => (query.scope ? record.scope === query.scope : true));
  if (sidecarResults.length) return sidecarResults.slice(0, limit);
  if (memoryIndex && store.sidecar?.list().length) return [];
  return rankRecords(records, query.query, fallbackMode).slice(0, limit).map((entry) => entry.record);
}
