import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNativeStore } from '../src/store.js';
import { searchIndex } from '../src/search-index.js';

describe('search index limiting and relevance filtering', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'byomem-search-index-limit-'));
    dirs.push(dir);
    return dir;
  }

  it('defaults to a small top-N result set', async () => {
    const store = openNativeStore({ baseDir: tempDir() });

    try {
      for (let index = 0; index < 12; index += 1) {
        store.write({
          scope: 'project',
          identity: { namespace: 'byomem', leafName: `Alpha ${index}`, parentContext: 'Root' },
          content: { text: `alpha memory ${index}` },
          provenance: { source: 'fixtures', adapter: 'native-store', origin: 'search-test' },
        });
      }

      const results = await searchIndex(store, { query: 'alpha' });
      expect(results).toHaveLength(10);
    } finally {
      store.close();
    }
  });

  it('suppresses irrelevant records for non-empty queries', async () => {
    const store = openNativeStore({ baseDir: tempDir() });

    try {
      store.write({
        scope: 'project',
        identity: { namespace: 'byomem', leafName: 'Relevant Alpha', parentContext: 'Root' },
        content: { text: 'alpha matching record' },
        provenance: { source: 'fixtures', adapter: 'native-store', origin: 'search-test' },
      });
      store.write({
        scope: 'project',
        identity: { namespace: 'byomem', leafName: 'Irrelevant Gamma', parentContext: 'Root' },
        content: { text: 'completely unrelated content' },
        provenance: { source: 'fixtures', adapter: 'native-store', origin: 'search-test' },
      });

      const results = await searchIndex(store, { query: 'alpha' });
      expect(results.map((record) => record.identity.leafName)).toEqual(['relevant-alpha']);
    } finally {
      store.close();
    }
  });
});
