import type { WriteIntent, MemoryRecord } from './contracts.js';
import type { NativeStore } from './store.js';
import { normalizeWriteIntent } from './normalizers.js';

export interface QueueWriterResult {
  record: MemoryRecord;
}

function ensureIntent(intent: WriteIntent): WriteIntent {
  if (!intent.identity?.namespace || !intent.identity?.leafName || !intent.scope) {
    throw new Error('Invalid write intent');
  }
  return intent;
}

export function openQueueWriter(store: NativeStore) {
  return {
    async write(intent: WriteIntent): Promise<QueueWriterResult> {
      const normalized = normalizeWriteIntent(ensureIntent(intent));
      return { record: await store.write(normalized) };
    },
  };
}
