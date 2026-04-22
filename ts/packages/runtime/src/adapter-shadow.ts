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
      const result = await adaptWrite(adapter, intent);
      const native = (result && typeof result === 'object' && 'record' in result ? (result as unknown as { record: MemoryRecord }).record : result) as MemoryRecord | undefined;
      const legacy = legacyRead();
      return { legacy, native, diffs: legacy && native && legacy.identity?.stableKey && native.identity?.stableKey ? diffRecords(legacy, native) : [] };
    },
    async replace(_intent: WriteIntent): Promise<ShadowResult> {
      throw new Error('Unsupported direct replace on shared write boundary');
    },
    prune(_intent: Pick<WriteIntent, 'identity' | 'scope'>): ShadowResult {
      throw new Error('Unsupported direct prune on shared write boundary');
    },
  };
}

export function isShadowModeEnabled(mode?: string): boolean {
  return mode === 'ts-native-shadow';
}
