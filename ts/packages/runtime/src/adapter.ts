import type { WriteIntent } from './contracts.js';
import type { NativeStore } from './store.js';
import { openWritePath, type WritePath } from './write-path.js';

export interface NativeAdapter {
  writePath: WritePath;
}

export function openNativeAdapter(store: NativeStore): NativeAdapter {
  return { writePath: openWritePath(store) };
}

export function adaptWrite(adapter: NativeAdapter, intent: WriteIntent) {
  return adapter.writePath.write(intent);
}

export function adaptReplace(adapter: NativeAdapter, intent: WriteIntent) {
  return adapter.writePath.replace(intent);
}

export function adaptPrune(adapter: NativeAdapter, intent: Pick<WriteIntent, 'identity' | 'scope'>) {
  return adapter.writePath.prune(intent);
}
