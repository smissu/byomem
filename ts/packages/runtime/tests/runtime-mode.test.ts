import { describe, expect, it } from 'vitest';
import { resolveRuntimeMode } from '../src/runtime-mode.js';

describe('resolveRuntimeMode', () => {
  it('defaults to python-default', () => {
    expect(resolveRuntimeMode()).toBe('python-default');
  });

  it('accepts ts-native and ts-native-shadow', () => {
    expect(resolveRuntimeMode('ts-native')).toBe('ts-native');
    expect(resolveRuntimeMode('ts-native-shadow')).toBe('ts-native-shadow');
  });
});
