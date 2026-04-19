import type { WriteIntent, MemoryRecord } from './contracts.js';
import type { NativeAdapter } from './adapter.js';
import { adaptReplace, adaptWrite, adaptPrune } from './adapter.js';
import { diffRecords, type ShadowDiff } from './shadow-diff.js';

export interface ShadowResult {
  legacy: MemoryRecord | undefined;
  native: MemoryRecord | undefined;
  diffs: ShadowDiff[];
}

export interface ShadowAdapter {
  write(intent: WriteIntent): ShadowResult;
  replace(intent: WriteIntent): ShadowResult;
  prune(intent: Pick<WriteIntent, 'identity' | 'scope'>): ShadowResult;
}

export function openShadowAdapter(adapter: NativeAdapter, legacyRead: () => MemoryRecord | undefined): ShadowAdapter {
  return {
    write(intent: WriteIntent): ShadowResult {
      const native = adaptWrite(adapter, intent).record;
      const legacy = legacyRead();
      return { legacy, native, diffs: legacy && native ? diffRecords(legacy, native) : [] };
    },
    replace(intent: WriteIntent): ShadowResult {
      const native = adaptReplace(adapter, intent).record;
      const legacy = legacyRead();
      return { legacy, native, diffs: legacy && native ? diffRecords(legacy, native) : [] };
    },
    prune(intent: Pick<WriteIntent, 'identity' | 'scope'>): ShadowResult {
      adaptPrune(adapter, intent);
      const legacy = legacyRead();
      return { legacy, native: undefined, diffs: [] };
    },
  };
}
