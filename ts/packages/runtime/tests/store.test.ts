import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNativeStore } from '../src/store.js';
import { normalizeIdentity, normalizeStableKey } from '../src/identity.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-runtime-store-'));
}

describe('native store', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it('writes and reads a stable record id', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const store = openNativeStore({ baseDir: dir });

    const record = await store.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Project Alpha' },
      content: { text: 'hello' },
      provenance: { source: 'docs' },
    });

    expect(record.id).toBe('project:byomem:root:project-alpha');
    expect(store.read(record.id)).toMatchObject({
      id: record.id,
      scope: 'project',
      provenance: { source: 'docs' },
      content: { text: 'hello' },
    });
  });

  it('reopens snapshot-backed records from disk', async () => {
    const dir = tempDir();
    dirs.push(dir);

    const first = openNativeStore({ baseDir: dir });
    const record = await first.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Project Beta', parentContext: 'root' },
      content: { structured: { ok: true } },
      provenance: { source: 'fixtures' },
    });
    first.close();

    const second = openNativeStore({ baseDir: dir });
    expect(second.list()).toHaveLength(1);
    expect(second.read(record.id)).toMatchObject({
      id: record.id,
      identity: {
        namespace: 'byomem',
        leafName: 'project-beta',
        parentContext: 'root',
      },
      content: { structured: { ok: true } },
    });
  });

  it('keeps same logical records stable and scopes separated', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const store = openNativeStore({ baseDir: dir });

    const projectRecord = await store.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Project Alpha', parentContext: 'root' },
      content: { text: 'one' },
      provenance: { source: 'docs' },
    });

    const projectRecordAgain = await store.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Project   Alpha', parentContext: 'root ' },
      content: { text: 'two' },
      provenance: { source: 'docs' },
    });

    const dirRecord = await store.write({
      scope: 'dir',
      identity: { namespace: 'byomem', leafName: 'Project Alpha', parentContext: 'root' },
      content: { text: 'dir' },
      provenance: { source: 'docs' },
    });

    expect(projectRecord.id).toBe(normalizeStableKey('project', { namespace: 'byomem', leafName: 'Project Alpha', parentContext: 'root' }));
    expect(projectRecordAgain.id).toBe(projectRecord.id);
    expect(dirRecord.id).toBe(normalizeStableKey('dir', { namespace: 'byomem', leafName: 'Project Alpha', parentContext: 'root' }));
    expect(dirRecord.id).not.toBe(projectRecord.id);
  });
});
