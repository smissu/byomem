import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNativeStore } from '../src/store.js';
import { retrieveBaseline } from '../src/retrieval.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-runtime-retrieval-'));
}

describe('retrieval baseline', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it('returns identity hits by id with identity reason', () => {
    const dir = tempDir();
    dirs.push(dir);
    const store = openNativeStore({ baseDir: dir });
    const record = store.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Project Alpha', parentContext: 'Root' },
      content: { text: 'alpha' },
      provenance: { source: 'fixtures' },
    });

    const results = retrieveBaseline(store, { id: record.id, scope: 'project' });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ reason: 'identity', record: { id: record.id } });
  });

  it('hydrates identity-style lookup and classifies baseline results deterministically', () => {
    const dir = tempDir();
    dirs.push(dir);
    const store = openNativeStore({ baseDir: dir });
    const record = store.write({
      scope: 'dir',
      identity: { namespace: 'byomem', leafName: 'Project Alpha', parentContext: 'Workspace/Docs' },
      content: { text: 'alpha dir' },
      provenance: { source: 'fixtures' },
    });

    const hydrated = retrieveBaseline(store, {
      id: 'missing-id',
      scope: 'dir',
      namespace: 'byomem',
      leafName: 'Project Alpha',
      parentContext: 'Workspace/Docs',
    });

    expect(hydrated).toHaveLength(1);
    expect(hydrated[0]).toMatchObject({ reason: 'identity', record: { id: record.id } });

    const baseline = retrieveBaseline(store, { scope: 'dir' });
    expect(baseline[0]).toMatchObject({ reason: 'scope-filtered' });
  });
});
