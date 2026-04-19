import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNativeStore } from '../src/store.js';
import { normalizeStableKey } from '../src/identity.js';
import fixtures from '../fixtures/sprint-20-native-store-fixtures.json';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-runtime-sprint-20-'));
}

describe('Sprint 20 native store write path', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it('writes the request/response slice for project scope', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const store = openNativeStore({ baseDir: dir });

    const record = await store.write(fixtures.projectWriteIntent);

    expect(record).toMatchObject({
      scope: 'project',
      provenance: fixtures.projectWriteIntent.provenance,
      content: fixtures.projectWriteIntent.content,
      identity: {
        namespace: 'byomem',
        leafName: 'sprint-20-project-alpha',
        parentContext: 'root',
      },
    });
    expect(record.id).toBe(normalizeStableKey('project', fixtures.projectWriteIntent.identity));
    expect(record.metadata?.createdAt).toBeTruthy();
    expect(record.metadata?.updatedAt).toBeTruthy();
  });

  it('writes the request/response slice for user scope', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const store = openNativeStore({ baseDir: dir });

    const record = await store.write(fixtures.userWriteIntent);

    expect(record).toMatchObject({
      scope: 'user',
      provenance: fixtures.userWriteIntent.provenance,
      content: fixtures.userWriteIntent.content,
      identity: {
        namespace: 'byomem',
        leafName: 'sprint-20-user-alpha',
        parentContext: 'root',
      },
    });
    expect(record.id).toBe(normalizeStableKey('user', fixtures.userWriteIntent.identity));
  });

  it('replaces an existing record in place for the same stable id', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const store = openNativeStore({ baseDir: dir });

    const first = await store.write(fixtures.replaceWriteIntent);
    const second = await store.write({
      ...fixtures.replaceWriteIntent,
      content: { text: 'replacement content v2' },
    });

    expect(second.id).toBe(first.id);
    expect(store.list()).toHaveLength(1);
    expect(store.read(first.id)).toMatchObject({
      id: first.id,
      content: { text: 'replacement content v2' },
      metadata: {
        createdAt: first.metadata?.createdAt,
      },
    });
    expect(second.metadata?.createdAt).toBe(first.metadata?.createdAt);
    expect(second.metadata?.updatedAt).toBeTruthy();
  });

  it('does not write when a candidate is not approved', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const store = openNativeStore({ baseDir: dir });

    const before = store.list();
    expect(fixtures.candidateApproval.approved).toBe(false);
    expect(before).toHaveLength(0);

    const after = store.list();
    expect(after).toHaveLength(0);
  });

  it('preserves existing metadata fields while refreshing timestamps on write', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const seedPath = join(dir, 'native-store.json');
    const seeded = {
      version: 1,
      records: [fixtures.metadataSeedRecord],
    };
    writeFileSync(seedPath, `${JSON.stringify(seeded, null, 2)}\n`, 'utf8');

    const seededStore = openNativeStore({ baseDir: dir });
    const updated = await seededStore.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Sprint 20 Metadata Alpha', parentContext: 'root' },
      content: { text: 'updated' },
      provenance: { source: 'fixtures' },
    });

    expect(updated.metadata).toMatchObject({
      createdAt: fixtures.metadataSeedRecord.metadata?.createdAt,
      updatedAt: expect.any(String),
    });
  });
});
