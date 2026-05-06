import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNativeStore } from '../src/store.js';
import { searchIndex } from '../src/search-index.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-sprint-61-db-only-'));
}

describe('Sprint 61 DB-only memory store', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('writes, reads, reopens, searches, and closes without native-store.json', async () => {
    const dir = tempDir();
    dirs.push(dir);

    const first = openNativeStore({ baseDir: dir, embeddingModel: 'fallback-deterministic-v1' });
    const record = await first.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'SQLite Canonical', parentContext: 'root' },
      content: { text: 'sqlite canonical memory marker' },
      provenance: { source: 'sprint-61' },
    });

    expect(existsSync(join(dir, 'native-store.json'))).toBe(false);
    expect(existsSync(join(dir, 'byomem-index.sqlite'))).toBe(true);
    expect(first.read(record.id)?.content.text).toBe('sqlite canonical memory marker');
    expect(first.list().map((entry) => entry.id)).toContain(record.id);
    expect((await searchIndex(first, { query: 'canonical memory marker', mode: 'bm25', limit: 5 }))[0]?.id).toBe(record.id);
    first.close();
    expect(existsSync(join(dir, 'native-store.json'))).toBe(false);

    const second = openNativeStore({ baseDir: dir, embeddingModel: 'fallback-deterministic-v1' });
    expect(second.read(record.id)?.content.text).toBe('sqlite canonical memory marker');
    expect(second.list()).toHaveLength(1);
    second.close();
    expect(existsSync(join(dir, 'native-store.json'))).toBe(false);
  });

  it('prunes from SQLite records, FTS, embeddings, and warm search results', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const store = openNativeStore({ baseDir: dir, embeddingModel: 'fallback-deterministic-v1' });
    const record = await store.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Prune Canonical', parentContext: 'root' },
      content: { text: 'canonical prune marker' },
      provenance: { source: 'sprint-61' },
    });

    expect((await searchIndex(store, { query: 'canonical prune marker', mode: 'bm25', limit: 5 }))[0]?.id).toBe(record.id);
    expect(store.prune(record.id)?.id).toBe(record.id);
    expect(store.read(record.id)).toBeUndefined();
    expect(store.sidecar?.db.prepare('SELECT COUNT(*) AS count FROM records WHERE id = ?').get(record.id)).toMatchObject({ count: 0 });
    expect(store.sidecar?.db.prepare('SELECT COUNT(*) AS count FROM records_fts WHERE id = ?').get(record.id)).toMatchObject({ count: 0 });
    expect(store.sidecar?.db.prepare('SELECT COUNT(*) AS count FROM record_embeddings WHERE record_id = ?').get(record.id)).toMatchObject({ count: 0 });
    expect(await searchIndex(store, { query: 'canonical prune marker', mode: 'bm25', limit: 5 })).toEqual([]);
    expect(existsSync(join(dir, 'native-store.json'))).toBe(false);
    store.close();
  });
});
