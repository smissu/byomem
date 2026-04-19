import type { MemoryRecord, MemoryScope } from './contracts.js';
import type { NativeStore } from './store.js';
import { rankRecords, type SearchMode } from './ranking.js';

export interface SearchQuery {
  query: string;
  scope?: MemoryScope;
  mode?: SearchMode;
  limit?: number;
}

export async function searchIndex(store: NativeStore, query: SearchQuery): Promise<MemoryRecord[]> {
  const limit = query.limit ?? 10;
  const sidecarResults = store.sidecar ? await store.sidecar.search(query.query, query.scope, limit) : [];
  if (sidecarResults.length) return sidecarResults.slice(0, limit);
  const mode = query.mode ?? 'hybrid';
  const records = store.list().filter((record) => (query.scope ? record.scope === query.scope : true));
  return rankRecords(records, query.query, mode).slice(0, limit).map((entry) => entry.record);
}
