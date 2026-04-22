import type { WriteIntent } from './contracts.js';
import type { NativeStore } from './store.js';
import { openQueueRuntime, type QueueRuntime } from './queue-runtime.js';

export interface NativeAdapter {
  queueRuntime: QueueRuntime;
}

export function openNativeAdapter(store: NativeStore): NativeAdapter {
  return { queueRuntime: openQueueRuntime(store, { baseDir: store['baseDir' as never] ?? '' }) };
}

export async function adaptWrite(adapter: NativeAdapter, intent: WriteIntent) {
  return adapter.queueRuntime.write(intent);
}

export function adaptReplace(_adapter: NativeAdapter, _intent: WriteIntent) {
  throw new Error('Unsupported direct replace on shared write boundary');
}

export function adaptPrune(_adapter: NativeAdapter, _intent: Pick<WriteIntent, 'identity' | 'scope'>) {
  throw new Error('Unsupported direct prune on shared write boundary');
}
