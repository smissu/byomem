import type { MemoryRecord, WriteIntent } from './contracts.js';
import type { NativeStore } from './store.js';
import { normalizeWriteIntent } from './normalizers.js';
import { openQueueWriter } from './queue-writer.js';

export interface WritePath {
  write(intent: WriteIntent): Promise<StoreActionResult>;
}

export interface GuardedWritePath extends WritePath {
  replace(intent: WriteIntent): Promise<StoreActionResult>;
  prune(intent: Pick<WriteIntent, 'identity' | 'scope'>): StoreActionResult;
}

export interface StoreActionResult {
  kind: 'write';
  record?: MemoryRecord;
}

function ensureIntent(intent: WriteIntent): WriteIntent {
  if (!intent.identity?.namespace || !intent.identity?.leafName || !intent.scope) {
    throw new Error('Invalid write intent');
  }
  return intent;
}

export function openWritePath(store: NativeStore): GuardedWritePath {
  const queueWriter = openQueueWriter(store);
  return {
    async write(intent: WriteIntent): Promise<StoreActionResult> {
      return { kind: 'write', record: (await queueWriter.write(normalizeWriteIntent(ensureIntent(intent)))).record };
    },
    async replace(_intent: WriteIntent): Promise<StoreActionResult> {
      throw new Error('Unsupported direct replace on shared write boundary');
    },
    prune(_intent: Pick<WriteIntent, 'identity' | 'scope'>): StoreActionResult {
      throw new Error('Unsupported direct prune on shared write boundary');
    },
  };
}
