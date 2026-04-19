import { describe, expect, it } from 'vitest';
import { openNativeStore } from '../src/store.js';
import { searchIndex } from '../src/search-index.js';

describe('search index limiting and relevance filtering', () => {
  it('defaults to a small top-N result set', () => {
    const store = openNativeStore({ baseDir: '/tmp/byomem-search-limit-default' });

    for (let index = 0; index < 12; index += 1) {
      store.write({
        scope: 'project',
        identity: { namespace: 'byomem', leafName: `Alpha ${index}`, parentContext: 'Root' },
        content: { text: `alpha memory ${index}` },
        provenance: { source: 'fixtures', adapter: 'native-store', origin: 'search-test' },
      });
    }

    const results = searchIndex(store, { query: 'alpha' });
    expect(results).toHaveLength(10);
  });

  it('suppresses irrelevant records for non-empty queries', () => {
    const store = openNativeStore({ baseDir: '/tmp/byomem-search-relevance' });

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

    const results = searchIndex(store, { query: 'alpha' });
    expect(results.map((record) => record.identity.leafName)).toEqual(['relevant-alpha']);
  });
});
