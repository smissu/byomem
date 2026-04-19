import type { WriteIntent } from './contracts.js';
import type { NativeStore } from './store.js';
import { openNativeAdapter } from './adapter.js';
import { openShadowAdapter, type ShadowResult } from './adapter-shadow.js';

export interface ShadowHarness {
  write(intent: WriteIntent): ShadowResult;
  replace(intent: WriteIntent): ShadowResult;
  prune(intent: Pick<WriteIntent, 'identity' | 'scope'>): ShadowResult;
}

export function openShadowHarness(store: NativeStore, legacyRead: () => ReturnType<NativeStore['read']>): ShadowHarness {
  const adapter = openNativeAdapter(store);
  const shadow = openShadowAdapter(adapter, legacyRead);
  return {
    write(intent: WriteIntent): ShadowResult {
      return shadow.write(intent);
    },
    replace(intent: WriteIntent): ShadowResult {
      return shadow.replace(intent);
    },
    prune(intent: Pick<WriteIntent, 'identity' | 'scope'>): ShadowResult {
      return shadow.prune(intent);
    },
  };
}
