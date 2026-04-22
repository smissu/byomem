import type { WriteIntent } from './contracts.js';
import type { NativeStore } from './store.js';
import { openNativeAdapter } from './adapter.js';
import { openShadowAdapter, type ShadowResult } from './adapter-shadow.js';

export interface ShadowHarness {
  write(intent: WriteIntent): Promise<ShadowResult>;
}

export function openShadowHarness(store: NativeStore, legacyRead: () => ReturnType<NativeStore['read']>): ShadowHarness {
  const adapter = openNativeAdapter(store);
  const shadow = openShadowAdapter(adapter, legacyRead);
  return {
    async write(intent: WriteIntent): Promise<ShadowResult> {
      return shadow.write(intent);
    },
  };
}
