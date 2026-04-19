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

export function writeRecord(store: NativeStore, intent: WriteIntent): StoreActionResult {
  return { kind: 'write', record: store.write(intent) };
}

export function replaceRecord(store: NativeStore, intent: WriteIntent): StoreActionResult {
  const existing = store.list().find((record) => matchesIntent(record, intent));
  const removed = existing ? [existing] : [];
  const record = store.write(intent);
  return { kind: 'replace', record, removed };
}

export function pruneRecords(store: NativeStore, intent: Pick<WriteIntent, 'identity' | 'scope'>): StoreActionResult {
  const targetId = intent.identity.stableKey;
  const removed = targetId ? store.prune(targetId) : undefined;
  return { kind: 'prune', removed: removed ? [removed] : [] };
}
