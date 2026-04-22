import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

  it('routes adapter write through queue-backed persistence and guards direct replace/prune', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const store = openNativeStore({ baseDir: dir });
    const adapter = openNativeAdapter(store);

    const initialList = store.list();

    const written = await adaptWrite(adapter, {
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Adapter Path', parentContext: 'Root' },
      content: { text: 'one' },
      provenance: { source: 'fixtures' },
    });

    expect(written?.event?.kind).toBe('write');
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.content.text).toBe('one');
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.content.text).toBe('one');
    expect(initialList).toHaveLength(0);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.content.text).toBe('one');
    expect(existsSync(join(dir, 'queue.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'queue.json'), 'utf8'))).toMatchObject({
      version: 1,
      jobs: [
        expect.objectContaining({
          state: 'flushed',
          offset: expect.any(Number),
          event: expect.objectContaining({ kind: expect.any(String) }),
        }),
      ],
    });

    expect(() => adaptReplace(adapter, {
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Adapter Path', parentContext: 'Root' },
      content: { text: 'two' },
      provenance: { source: 'fixtures' },
    })).toThrow('Unsupported direct replace on shared write boundary');
    expect(() => adaptPrune(adapter, {
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Adapter Path', parentContext: 'Root', stableKey: written.record?.id },
    } as never)).toThrow('Unsupported direct prune on shared write boundary');
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.content.text).toBe('one');
  });
});
