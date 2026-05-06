import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNativeStore } from '../src/store.js';
import { openWritePath } from '../src/write-path.js';
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

  it('writes through the public write-path surface and rejects direct replace/prune', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const store = openNativeStore({ baseDir: dir });
    const writePath = openWritePath(store);

    const written = await writePath.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Write Path', parentContext: 'Root' },
      content: { text: 'one' },
      provenance: { source: 'fixtures' },
    });
    expect(written.kind).toBe('write');
    expect(written.record?.id).toBeDefined();
    expect(() => writePath.prune({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Write Path', parentContext: 'Root', stableKey: 'project:wrong:manual:wrong-key' },
    })).toThrow('Unsupported direct prune on shared write boundary');
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.content.text).toBe('one');
  });

  it('rejects invalid mutation intents', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const store = openNativeStore({ baseDir: dir });
    const writePath = openWritePath(store);

    await expect(writePath.write({ scope: 'project', identity: { namespace: '', leafName: '' }, content: { text: 'x' } } as never)).rejects.toThrow('Invalid write intent');
    expect(() => writePath.prune({ scope: 'project', identity: { namespace: '', leafName: '' } } as never)).toThrow('Unsupported direct prune on shared write boundary');
  });

  it('integrates write -> read/search consistency through public surfaces', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const store = openNativeStore({ baseDir: dir });
    const writePath = openWritePath(store);

    const result = await writePath.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Integrated Path', parentContext: 'Root' },
      content: { text: 'integrated path baseline' },
      provenance: { source: 'fixtures', origin: 'write-path' },
    });

    const record = result.record!;
    expect(openReadPath(store).retrieve({ id: record.id, scope: 'project' })[0]?.record.id).toBe(record.id);
    expect((await searchIndex(store, { query: 'integrated path baseline', mode: 'bm25' }))[0]?.id).toBe(record.id);
  });
});
