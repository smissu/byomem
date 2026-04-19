import { describe, expect, it } from 'vitest';
import { enforceNoPythonDefaultPath } from '../src/no-python-hook.js';
import { resolveRuntimeMode } from '../src/runtime-mode.js';
import { openNativeAdapter } from '../src/adapter.js';
import { openNativeStore } from '../src/store.js';

describe('runtime mode', () => {
  it('defaults to ts-native and rejects python-default as a default path', () => {
    expect(resolveRuntimeMode()).toBe('ts-native');
    expect(resolveRuntimeMode('ts-native-shadow')).toBe('ts-native-shadow');
    expect(() => enforceNoPythonDefaultPath('python-default')).toThrow('Python default runtime path is disabled by default');
  });

  it('exposes a TS-native package surface without a python-default active path', () => {
    const store = openNativeStore({ baseDir: '/tmp/byomem-runtime-mode' });
    const adapter = openNativeAdapter(store);

    expect(adapter.writePath.write).toBeTypeOf('function');
    expect(resolveRuntimeMode()).not.toBe('python-default');
  });
});
