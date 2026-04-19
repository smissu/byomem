import type { MemoryRecord, MemoryScope } from './contracts.js';
import type { NativeStore } from './store.js';
import { rankRecords, type SearchMode } from './ranking.js';

export interface SearchQuery {
  query: string;
  scope?: MemoryScope;
  mode?: SearchMode;
  limit?: number;
}

export function searchIndex(store: NativeStore, query: SearchQuery): MemoryRecord[] {
  const mode = query.mode ?? 'hybrid';
  const limit = query.limit ?? 10;
  const records = store.list().filter((record) => (query.scope ? record.scope === query.scope : true));
  return rankRecords(records, query.query, mode).slice(0, limit).map((entry) => entry.record);
}
