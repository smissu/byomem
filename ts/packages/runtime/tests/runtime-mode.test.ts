import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enforceNoPythonDefaultPath } from '../src/no-python-hook.ts';
import { resolveRuntimeMode } from '../src/runtime-mode.ts';
import { openNativeAdapter, adaptReplace, adaptPrune, adaptWrite } from '../src/adapter.ts';
import { openNativeStore } from '../src/store.ts';
import { assertNoPythonDefaultPath } from '../src/no-python-default-path.ts';
import * as runtimePackage from '../src/index.js';

describe('runtime mode', () => {
  it('defaults to ts-native and rejects python-default as a default path', () => {
    expect(resolveRuntimeMode()).toBe('ts-native');
    expect(resolveRuntimeMode('ts-native-shadow')).toBe('ts-native-shadow');
    expect(() => enforceNoPythonDefaultPath('python-default')).toThrow('Python default runtime path is disabled by default');
  });

  it('exposes a TS-native package surface with queue-backed writes and guarded replace/prune', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'byomem-runtime-mode-'));
    try {
      const store = openNativeStore({ baseDir: dir });
      const adapter = openNativeAdapter(store);

      expect(resolveRuntimeMode()).not.toBe('python-default');

      const before = store.list().length;

      expect((adapter as { writePath?: unknown }).writePath).toBeUndefined();
      expect('openNativeStore' in runtimePackage).toBe(false);
      expect('openSqliteSidecar' in runtimePackage).toBe(false);
      expect('openWritePath' in runtimePackage).toBe(false);
      expect('writeRecord' in runtimePackage).toBe(false);
      const writeResult = await adaptWrite(adapter, {
        scope: 'project',
        identity: { namespace: 'byomem', leafName: 'Runtime Mode', parentContext: 'root' },
        content: { text: 'queued write' },
        provenance: { source: 'fixtures' },
      });
      expect(writeResult?.event?.kind).toBe('write');
      expect(store.list()).toHaveLength(1);
      expect(store.list()[0]?.content.text).toBe('queued write');
      expect(before).toBe(0);
      expect(store.list()).toHaveLength(1);
      expect(store.list()[0]?.content.text).toBe('queued write');
      expect(JSON.parse(readFileSync(join(dir, 'queue.json'), 'utf8'))).toMatchObject({
        jobs: [expect.objectContaining({ state: 'flushed' })],
      });

      expect(() => adaptReplace(adapter, {
        scope: 'project',
        identity: { namespace: 'byomem', leafName: 'Runtime Mode', parentContext: 'root' },
        content: { text: 'direct replace' },
        provenance: { source: 'fixtures' },
      })).toThrow('Unsupported direct replace on shared write boundary');
      expect(() => adaptPrune(adapter, {
        scope: 'project',
        identity: { namespace: 'byomem', leafName: 'Runtime Mode', parentContext: 'root', stableKey: writeResult.record?.id },
      } as never)).toThrow('Unsupported direct prune on shared write boundary');
      expect(store.list()).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects python-default through the direct TS-native guard path', () => {
    expect(() => assertNoPythonDefaultPath('python-default')).toThrow('Python default runtime path is disabled by default');
  });
});
