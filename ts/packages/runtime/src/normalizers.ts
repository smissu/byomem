import type { MemoryIdentity, MemoryRecord, MemoryScope, QueueEvent, WriteIntent } from './contracts.js';

export function normalizeLeafName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}

export function normalizeIdentity(identity: MemoryIdentity): MemoryIdentity {
  return {
    namespace: identity.namespace.trim(),
    leafName: normalizeLeafName(identity.leafName),
    parentContext: identity.parentContext?.trim() || undefined,
  };
}

export function normalizeScope(scope: MemoryScope): MemoryScope {
  return scope;
}

export function normalizeWriteIntent(intent: WriteIntent): WriteIntent {
  return {
    ...intent,
    identity: normalizeIdentity(intent.identity),
    scope: normalizeScope(intent.scope),
  };
}

export function normalizeRecord(record: MemoryRecord): MemoryRecord {
  return {
    ...record,
    identity: normalizeIdentity(record.identity),
    scope: normalizeScope(record.scope),
  };
}

export function normalizeQueueEvent(event: QueueEvent): QueueEvent {
  return {
    ...event,
    kind: event.kind,
  };
}
