import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNativeStore } from '../src/store.js';
import { searchIndex } from '../src/search-index.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-sprint-61-json-migration-'));
}

const legacyRecord = {
  id: 'project:byomem:root:legacy-json',
  scope: 'project',
  identity: { namespace: 'byomem', leafName: 'legacy-json', parentContext: 'root' },
  provenance: { source: 'legacy-fixture', adapter: 'json' },
  content: { text: 'legacy json import marker', structured: { kind: 'legacy' } },
  metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
};

function writeLegacySnapshot(dir: string, records = [legacyRecord]): void {
  writeFileSync(join(dir, 'native-store.json'), `${JSON.stringify({ version: 1, records }, null, 2)}\n`, 'utf8');
}

describe('Sprint 61 native-store.json migration', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('imports legacy JSON into empty SQLite, preserves metadata, and renames the snapshot', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeLegacySnapshot(dir);

    const store = openNativeStore({ baseDir: dir, embeddingModel: 'fallback-deterministic-v1' });
    expect(existsSync(join(dir, 'native-store.json'))).toBe(false);
    expect(existsSync(join(dir, 'native-store.json.migrated'))).toBe(true);
    expect(store.read(legacyRecord.id)).toMatchObject({
      id: legacyRecord.id,
      content: legacyRecord.content,
      provenance: legacyRecord.provenance,
      metadata: legacyRecord.metadata,
    });
    expect(store.sidecar?.db.prepare('SELECT COUNT(*) AS count FROM records_fts WHERE id = ?').get(legacyRecord.id)).toMatchObject({ count: 1 });
    expect((await searchIndex(store, { query: 'legacy json import marker', mode: 'bm25', limit: 5 }))[0]?.id).toBe(legacyRecord.id);
    store.close();
  });

  it('renames identical legacy JSON without duplicating existing SQLite records', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const first = openNativeStore({ baseDir: dir, embeddingModel: 'fallback-deterministic-v1' });
    await first.write({
      scope: 'project',
      identity: legacyRecord.identity,
      content: legacyRecord.content,
      provenance: legacyRecord.provenance,
    });
    const existing = first.read(legacyRecord.id)!;
    first.close();
    writeLegacySnapshot(dir, [existing]);

    const second = openNativeStore({ baseDir: dir, embeddingModel: 'fallback-deterministic-v1' });
    expect(existsSync(join(dir, 'native-store.json'))).toBe(false);
    expect(existsSync(join(dir, 'native-store.json.migrated'))).toBe(true);
    expect(second.list()).toHaveLength(1);
    second.close();
  });

  it('fails closed on conflicting JSON and SQLite records without deleting legacy data', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const first = openNativeStore({ baseDir: dir, embeddingModel: 'fallback-deterministic-v1' });
    await first.write({
      scope: 'project',
      identity: legacyRecord.identity,
      content: { text: 'sqlite version' },
      provenance: { source: 'sqlite-fixture' },
    });
    first.close();
    writeLegacySnapshot(dir);

    expect(() => openNativeStore({ baseDir: dir, embeddingModel: 'fallback-deterministic-v1' })).toThrow(/migration conflict/i);
    expect(existsSync(join(dir, 'native-store.json'))).toBe(true);
    expect(readFileSync(join(dir, 'native-store.json'), 'utf8')).toContain('legacy json import marker');
  });

  it('reports invalid legacy JSON without renaming it', () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'native-store.json'), '{"version":1,"records":"bad"}\n', 'utf8');

    expect(() => openNativeStore({ baseDir: dir })).toThrow(/Invalid native store snapshot/);
    expect(existsSync(join(dir, 'native-store.json'))).toBe(true);
    expect(existsSync(join(dir, 'native-store.json.migrated'))).toBe(false);
  });
});
