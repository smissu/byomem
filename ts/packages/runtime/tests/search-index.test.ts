import { describe, expect, it } from 'vitest';
import { searchIndex } from '../src/search-index.js';
import type { MemoryRecord } from '../src/contracts.js';
import fixtures from '../fixtures/sprint-19-search-ranking-fixtures.json';

const records = fixtures.records as MemoryRecord[];

function createStore(): { list: () => MemoryRecord[] } {
  return { list: () => records };
}

describe('search index baseline', () => {
  it('filters by scope and preserves deterministic ordering', () => {
    const results = searchIndex(createStore(), { query: 'alpha lexical only', scope: 'project', mode: 'hybrid' });
    expect(results.every((record) => record.scope === 'project')).toBe(true);
    expect(new Set(results.map((record) => record.id)).size).toBe(results.length);
  });

  it('returns hybrid results with lexical coverage preserved', () => {
    const results = searchIndex(createStore(), { query: 'alpha semantic rerank', mode: 'hybrid' });
    expect(results[0].id).toBe('project:byomem:root:alpha-semantic');
    expect(results.map((record) => record.id)).toContain('project:byomem:root:alpha-lexical');
  });
});
