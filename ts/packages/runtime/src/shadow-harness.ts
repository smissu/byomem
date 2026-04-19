import type { WriteIntent } from './contracts.js';
import type { NativeStore } from './store.js';
import { openNativeAdapter } from './adapter.js';
import { openShadowAdapter, type ShadowResult } from './adapter-shadow.js';

export interface ShadowHarness {
  write(intent: WriteIntent): Promise<ShadowResult>;
  replace(intent: WriteIntent): Promise<ShadowResult>;
  prune(intent: Pick<WriteIntent, 'identity' | 'scope'>): ShadowResult;
}

export function openShadowHarness(store: NativeStore, legacyRead: () => ReturnType<NativeStore['read']>): ShadowHarness {
  const adapter = openNativeAdapter(store);
  const shadow = openShadowAdapter(adapter, legacyRead);
  return {
    async write(intent: WriteIntent): Promise<ShadowResult> {
      return shadow.write(intent);
    },
    async replace(intent: WriteIntent): Promise<ShadowResult> {
      return shadow.replace(intent);
    },
    prune(intent: Pick<WriteIntent, 'identity' | 'scope'>): ShadowResult {
      return shadow.prune(intent);
    },
  };
}
