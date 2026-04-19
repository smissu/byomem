import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNativeStore } from '../src/store.js';
import { openNativeAdapter, adaptWrite, adaptReplace, adaptPrune } from '../src/adapter.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-runtime-adapter-'));
}

describe('adapter-facing write actions', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('routes write replace prune through the adapter surface', () => {
    const dir = tempDir();
    dirs.push(dir);
    const adapter = openNativeAdapter(openNativeStore({ baseDir: dir }));

    const written = adaptWrite(adapter, {
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Adapter Path', parentContext: 'Root' },
      content: { text: 'one' },
      provenance: { source: 'fixtures' },
    });
    const replaced = adaptReplace(adapter, {
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Adapter Path', parentContext: 'Root' },
      content: { text: 'two' },
      provenance: { source: 'fixtures' },
    });
    const pruned = adaptPrune(adapter, {
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Adapter Path', parentContext: 'Root', stableKey: written.record?.id },
    } as never);

    expect(written.record?.id).toBe(replaced.record?.id);
    expect(pruned.kind).toBe('prune');
    expect(adapter.writePath.prune({ scope: 'project', identity: { namespace: 'byomem', leafName: 'Adapter Path', parentContext: 'Root', stableKey: written.record?.id } } as never).removed).toHaveLength(0);
  });
});
