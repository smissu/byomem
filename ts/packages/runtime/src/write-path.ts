import type { WriteIntent } from './contracts.js';
import type { NativeStore } from './store.js';
import { normalizeWriteIntent } from './normalizers.js';
import { writeRecord, replaceRecord, pruneRecords, type StoreActionResult } from './store-actions.js';

export interface WritePath {
  write(intent: WriteIntent): StoreActionResult;
  replace(intent: WriteIntent): StoreActionResult;
  prune(intent: Pick<WriteIntent, 'identity' | 'scope'>): StoreActionResult;
}

function ensureIntent(intent: WriteIntent): WriteIntent {
  if (!intent.identity?.namespace || !intent.identity?.leafName || !intent.scope) {
    throw new Error('Invalid write intent');
  }
  return intent;
}

export function openWritePath(store: NativeStore): WritePath {
  return {
    write(intent: WriteIntent): StoreActionResult {
      return writeRecord(store, normalizeWriteIntent(ensureIntent(intent)));
    },
    replace(intent: WriteIntent): StoreActionResult {
      return replaceRecord(store, normalizeWriteIntent(ensureIntent(intent)));
    },
    prune(intent: Pick<WriteIntent, 'identity' | 'scope'>): StoreActionResult {
      if (!intent.identity?.stableKey || !intent.scope) {
        throw new Error('Invalid prune intent');
      }
      return pruneRecords(store, intent);
    },
  };
}
