import type { WriteIntent } from './contracts.js';
import type { NativeStore } from './store.js';
import { normalizeWriteIntent } from './normalizers.js';
import { normalizeStableKey } from './identity.js';
import { writeRecord, replaceRecord, pruneRecords, type StoreActionResult } from './store-actions.js';

export interface WritePath {
  write(intent: WriteIntent): Promise<StoreActionResult>;
  replace(intent: WriteIntent): Promise<StoreActionResult>;
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
    async write(intent: WriteIntent): Promise<StoreActionResult> {
      return await writeRecord(store, normalizeWriteIntent(ensureIntent(intent)));
    },
    async replace(intent: WriteIntent): Promise<StoreActionResult> {
      return await replaceRecord(store, normalizeWriteIntent(ensureIntent(intent)));
    },
    prune(intent: Pick<WriteIntent, 'identity' | 'scope'>): StoreActionResult {
      if (!intent.identity?.namespace || !intent.identity?.leafName || !intent.scope) {
        throw new Error('Invalid prune intent');
      }
      return pruneRecords(store, {
        scope: intent.scope,
        identity: {
          ...intent.identity,
          stableKey: normalizeStableKey(intent.scope, intent.identity),
        },
      });
    },
  };
}
