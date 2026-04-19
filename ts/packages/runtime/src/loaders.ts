import type { MemoryRecord, QueueEvent, WriteIntent } from './contracts.js';

// Sprint 16 scaffolding: minimal validation only; not a full parser.
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function loadMemoryRecord(input: unknown): MemoryRecord {
  if (!isObject(input)) throw new Error('Invalid MemoryRecord payload');
  if (typeof input.id !== 'string' || typeof input.scope !== 'string' || !isObject(input.provenance) || !isObject(input.identity) || !isObject(input.content)) {
    throw new Error('Invalid MemoryRecord payload');
  }
  return input as unknown as MemoryRecord;
}

export function loadWriteIntent(input: unknown): WriteIntent {
  if (!isObject(input) || !isObject(input.identity) || typeof input.scope !== 'string' || !isObject(input.content)) {
    throw new Error('Invalid WriteIntent payload');
  }
  return input as unknown as WriteIntent;
}

export function loadQueueEvent(input: unknown): QueueEvent {
  if (!isObject(input) || typeof input.eventId !== 'string' || typeof input.sessionId !== 'string' || typeof input.recordId !== 'string' || typeof input.kind !== 'string' || typeof input.createdAt !== 'string') {
    throw new Error('Invalid QueueEvent payload');
  }
  return input as unknown as QueueEvent;
}
