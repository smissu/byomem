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
  write(intent: WriteIntent): Promise<ShadowResult>;
  replace(intent: WriteIntent): Promise<ShadowResult>;
  prune(intent: Pick<WriteIntent, 'identity' | 'scope'>): ShadowResult;
}

export function openShadowAdapter(adapter: NativeAdapter, legacyRead: () => MemoryRecord | undefined): ShadowAdapter {
  return {
    async write(intent: WriteIntent): Promise<ShadowResult> {
      const native = (await adaptWrite(adapter, intent)).record;
      const legacy = legacyRead();
      return { legacy, native, diffs: legacy && native ? diffRecords(legacy, native) : [] };
    },
    async replace(intent: WriteIntent): Promise<ShadowResult> {
      const native = (await adaptReplace(adapter, intent)).record;
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

export function isShadowModeEnabled(mode?: string): boolean {
  return mode === 'ts-native-shadow';
}
