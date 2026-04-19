import type { MemoryRecord, MemoryScope } from './contracts.js';
import type { NativeStore } from './store.js';
import { normalizeStableKey } from './identity.js';

export interface RetrievalQuery {
  scope?: MemoryScope;
  id?: string;
  leafName?: string;
  namespace?: string;
  parentContext?: string;
}

export interface RetrievalResult {
  record: MemoryRecord;
  reason: 'identity' | 'scope-filtered' | 'baseline';
  provenance: MemoryRecord['provenance'];
}

function matchesScope(record: MemoryRecord, scope?: MemoryScope): boolean {
  return scope ? record.scope === scope : true;
}

function matchesIdentity(record: MemoryRecord, query: RetrievalQuery): boolean {
  if (query.id) return record.id === query.id;
  if (query.namespace && record.identity.namespace !== query.namespace.trim().toLowerCase()) return false;
  if (query.leafName && record.identity.leafName !== query.leafName.trim().toLowerCase().replace(/\s+/g, '-')) return false;
  if (query.parentContext && (record.identity.parentContext ?? 'root') !== query.parentContext.trim().toLowerCase()) return false;
  return true;
}

function sortBaseline(records: MemoryRecord[]): MemoryRecord[] {
  return [...records].sort((a, b) => a.id.localeCompare(b.id));
}

export function retrieveBaseline(store: NativeStore, query: RetrievalQuery): RetrievalResult[] {
  const records = sortBaseline(store.list().filter((record) => matchesScope(record, query.scope) && matchesIdentity(record, query)));

  if (query.id && records.length === 0 && query.namespace && query.leafName) {
    const fallbackId = normalizeStableKey(query.scope ?? 'project', {
      namespace: query.namespace,
      leafName: query.leafName,
      parentContext: query.parentContext,
    });
    const hydrated = store.read(fallbackId);
    if (hydrated) {
      return [{ record: hydrated, reason: 'identity', provenance: hydrated.provenance }];
    }
  }

  return records.map((record, index) => ({
    record,
    reason: query.id && index === 0 ? 'identity' : query.scope ? 'scope-filtered' : 'baseline',
    provenance: record.provenance,
  }));
}
