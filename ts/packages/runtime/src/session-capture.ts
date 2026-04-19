import type { MemoryRecord, QueueEvent, WriteIntent } from './contracts.js';
import type { NativeStore } from './store.js';
import { openQueueRuntime, type QueueRuntime } from './queue-runtime.js';

export interface SessionCaptureOptions {
  baseDir: string;
}

export interface SessionCaptureResult {
  runtime: QueueRuntime;
  emitted: MemoryRecord[];
}

export function openSessionCapture(store: NativeStore, options: SessionCaptureOptions): SessionCaptureResult {
  const emitted: MemoryRecord[] = [];
  const runtime = openQueueRuntime(store, options);

  return { runtime, emitted };
}

export function emitSessionRecord(store: NativeStore, intent: WriteIntent, event: QueueEvent): MemoryRecord {
  const record = store.write(intent);
  return {
    ...record,
    provenance: { ...record.provenance, origin: event.kind },
  };
}
