import type { MemoryRecord, WriteIntent } from './contracts.js';
import type { NativeStore } from './store.js';

export type StoreActionKind = 'write' | 'replace' | 'prune';

export interface StoreActionResult {
  kind: StoreActionKind;
  record?: MemoryRecord;
  removed?: MemoryRecord[];
}

function matchesIntent(record: MemoryRecord, intent: WriteIntent): boolean {
  return record.scope === intent.scope && record.identity.stableKey === intent.identity.stableKey && record.identity.namespace === intent.identity.namespace;
}

export async function replaceRecord(_store: NativeStore, _intent: WriteIntent): Promise<StoreActionResult> {
  throw new Error('Unsupported direct replace on shared write boundary');
}

export function pruneRecords(_store: NativeStore, _intent: Pick<WriteIntent, 'identity' | 'scope'>): StoreActionResult {
  throw new Error('Unsupported direct prune on shared write boundary');
}
