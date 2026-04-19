import { describe, expect, it } from 'vitest';
import { enforceNoPythonDefaultPath } from '../src/no-python-hook.ts';
import { resolveRuntimeMode } from '../src/runtime-mode.ts';
import { openNativeAdapter } from '../src/adapter.ts';
import { openNativeStore } from '../src/store.ts';
import { assertNoPythonDefaultPath } from '../src/no-python-default-path.ts';

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

  it('rejects python-default through the direct TS-native guard path', () => {
    expect(() => assertNoPythonDefaultPath('python-default')).toThrow('Python default runtime path is disabled by default');
  });
});
