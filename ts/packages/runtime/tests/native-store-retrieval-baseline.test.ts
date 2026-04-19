import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNativeStore } from '../src/store.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-runtime-retrieval-'));
}

describe('native store retrieval baseline', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it('keeps project and dir scope records isolated on readback', () => {
    const dir = tempDir();
    dirs.push(dir);

    const store = openNativeStore({ baseDir: dir });
    const project = store.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Project Alpha', parentContext: 'Root' },
      content: { text: 'project alpha baseline' },
      provenance: { source: 'fixtures', adapter: 'native-store' },
    });
    const dirRecord = store.write({
      scope: 'dir',
      identity: { namespace: 'byomem', leafName: 'Project Alpha', parentContext: 'Root' },
      content: { structured: { scope: 'dir' } },
      provenance: { source: 'fixtures', adapter: 'native-store' },
    });

    expect(store.read(project.id)).toMatchObject({
      id: 'project:byomem:root:project-alpha',
      scope: 'project',
      identity: {
        namespace: 'byomem',
        leafName: 'project-alpha',
        parentContext: 'root',
      },
      provenance: { source: 'fixtures', adapter: 'native-store' },
    });
    expect(store.read(dirRecord.id)).toMatchObject({
      id: 'dir:byomem:root:project-alpha',
      scope: 'dir',
      identity: {
        namespace: 'byomem',
        leafName: 'project-alpha',
        parentContext: 'root',
      },
      provenance: { source: 'fixtures', adapter: 'native-store' },
    });
    expect(project.id).not.toBe(dirRecord.id);
  });

  it('reloads records from disk without losing retrieval shape', () => {
    const dir = tempDir();
    dirs.push(dir);

    const first = openNativeStore({ baseDir: dir });
    const written = first.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Project Alpha', parentContext: 'Root' },
      content: { text: 'project alpha baseline' },
      provenance: { source: 'fixtures', adapter: 'native-store' },
    });
    first.close();

    const second = openNativeStore({ baseDir: dir });
    expect(second.read(written.id)).toMatchObject({
      id: written.id,
      scope: 'project',
      provenance: { source: 'fixtures', adapter: 'native-store' },
      identity: {
        namespace: 'byomem',
        leafName: 'project-alpha',
        parentContext: 'root',
      },
      metadata: expect.objectContaining({ createdAt: expect.any(String), updatedAt: expect.any(String) }),
    });
  });

  it('hydrates identity-style lookups into normalized stable records', () => {
    const dir = tempDir();
    dirs.push(dir);

    const store = openNativeStore({ baseDir: dir });
    const record = store.write({
      scope: 'project',
      identity: { namespace: ' BYOMEM ', leafName: 'Project Alpha', parentContext: ' Root ' },
      content: { text: 'project alpha baseline' },
      provenance: { source: 'fixtures', adapter: 'native-store' },
    });

    expect(record.id).toBe('project:byomem:root:project-alpha');
    expect(store.read(record.id)).toMatchObject({
      identity: {
        namespace: 'byomem',
        leafName: 'project-alpha',
        parentContext: 'root',
      },
    });
  });

  it('keeps lexical fallback-style retrieval available when semantic support is absent', () => {
    const dir = tempDir();
    dirs.push(dir);

    const store = openNativeStore({ baseDir: dir });
    const record = store.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Lexical Fallback', parentContext: 'Root' },
      content: { text: 'lexical fallback baseline' },
      provenance: { source: 'fixtures', adapter: 'native-store' },
    });

    const lexicalHit = store.list().find((candidate) => candidate.content.text?.includes('lexical fallback'));
    expect(lexicalHit?.id).toBe(record.id);
    expect(lexicalHit).toMatchObject({
      provenance: { source: 'fixtures', adapter: 'native-store' },
      content: { text: 'lexical fallback baseline' },
    });
  });

  it('preserves response reason and provenance shape on readback', () => {
    const dir = tempDir();
    dirs.push(dir);

    const store = openNativeStore({ baseDir: dir });
    const record = store.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Reasoned Response', parentContext: 'Root' },
      content: { structured: { answer: 'baseline' } },
      provenance: { source: 'fixtures', adapter: 'native-store', origin: 'read-path' },
    });

    expect(store.read(record.id)).toMatchObject({
      provenance: { source: 'fixtures', adapter: 'native-store', origin: 'read-path' },
      content: { structured: { answer: 'baseline' } },
      metadata: expect.objectContaining({ createdAt: expect.any(String), updatedAt: expect.any(String) }),
    });
  });
});
