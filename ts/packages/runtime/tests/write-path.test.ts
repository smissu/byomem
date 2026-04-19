import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNativeStore } from '../src/store.js';
import { openWritePath } from '../src/write-path.js';
import { openNativeAdapter, adaptWrite, adaptReplace, adaptPrune } from '../src/adapter.js';
import { openReadPath } from '../src/read.js';
import { searchIndex } from '../src/search-index.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-runtime-write-'));
}

describe('Sprint 20 write path', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('writes, replaces, and prunes through the public write-path surface', () => {
    const dir = tempDir();
    dirs.push(dir);
    const store = openNativeStore({ baseDir: dir });
    const writePath = openWritePath(store);

    const written = writePath.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Write Path', parentContext: 'Root' },
      content: { text: 'one' },
      provenance: { source: 'fixtures' },
    });
    const replaced = writePath.replace({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Write Path', parentContext: 'Root' },
      content: { text: 'two' },
      provenance: { source: 'fixtures' },
    });
    const pruned = writePath.prune({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Write Path', parentContext: 'Root', stableKey: written.record?.id },
    } as never);

    expect(written.record?.id).toBe(replaced.record?.id);
    expect(replaced.kind).toBe('replace');
    expect(pruned.kind).toBe('prune');
    expect(pruned.removed).toHaveLength(1);
    expect(store.list()).toHaveLength(0);
  });

  it('rejects invalid mutation intents', () => {
    const dir = tempDir();
    dirs.push(dir);
    const store = openNativeStore({ baseDir: dir });
    const writePath = openWritePath(store);

    expect(() => writePath.write({ scope: 'project', identity: { namespace: '', leafName: '' }, content: { text: 'x' } } as never)).toThrow('Invalid write intent');
    expect(() => writePath.prune({ scope: 'project', identity: { namespace: '', leafName: '' } } as never)).toThrow('Invalid prune intent');
  });

  it('integrates write -> read/search consistency through public surfaces', () => {
    const dir = tempDir();
    dirs.push(dir);
    const store = openNativeStore({ baseDir: dir });
    const writePath = openWritePath(store);

    const record = writePath.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Integrated Path', parentContext: 'Root' },
      content: { text: 'integrated path baseline' },
      provenance: { source: 'fixtures', origin: 'write-path' },
    }).record!;

    expect(openReadPath(store).retrieve({ id: record.id, scope: 'project' })[0]?.record.id).toBe(record.id);
    expect(searchIndex(store, { query: 'integrated path baseline', mode: 'lexical' })[0]?.id).toBe(record.id);
  });
});
