import { describe, expect, it } from 'vitest';
import { searchIndex } from '../src/search-index.js';
import { rankRecords } from '../src/ranking.js';
import { compareRecords } from '../src/parity.js';
import type { MemoryRecord } from '../src/contracts.js';
import fixtures from '../fixtures/sprint-19-search-ranking-fixtures.json';

const records = fixtures.records as MemoryRecord[];

function createStore(): { list: () => MemoryRecord[] } {
  return { list: () => records };
}

describe('Sprint 19 search/ranking parity slice', () => {
  it('keeps lexical-only ordering stable', async () => {
    const ranked = rankRecords(records, 'alpha lexical only', 'lexical');
    const ids = ranked.map((entry) => entry.record.id);

    expect(ids).toContain('project:byomem:root:alpha-lexical');
    expect(ids).toContain('project:byomem:root:alpha-semantic');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('allows semantic rerank to lift structured matches or hybrid merge to retain lexical coverage', async () => {
    const semantic = rankRecords(records, 'alpha semantic rerank', 'semantic');
    expect(semantic[0].record.id).toBe('project:byomem:root:alpha-semantic');
    expect(semantic.map((entry) => entry.record.id)).toContain('dir:byomem:root:alpha-duplicate');

    const hybrid = await searchIndex(createStore(), { query: 'alpha semantic rerank', mode: 'hybrid' });
    expect(hybrid[0].id).toBe('project:byomem:root:alpha-semantic');
    expect(hybrid.map((record) => record.id)).toContain('project:byomem:root:alpha-lexical');
  });

  it('suppresses duplicates by stable identity ordering when lexical content collides', async () => {
    const lexical = rankRecords(records, 'alpha lexical only', 'lexical');
    expect(new Set(lexical.map((entry) => entry.record.id)).size).toBe(lexical.length);
    expect(lexical.map((entry) => entry.record.id)).toContain('project:byomem:root:alpha-lexical');
    expect(lexical.map((entry) => entry.record.id)).toContain('project:byomem:root:alpha-semantic');
  });

  it('keeps scope isolation across search slices', async () => {
    expect((await searchIndex(createStore(), { query: 'alpha lexical only', scope: 'project', mode: 'lexical' })).every((record) => record.scope === 'project')).toBe(true);
    expect((await searchIndex(createStore(), { query: 'alpha lexical only', scope: 'dir', mode: 'lexical' })).every((record) => record.scope === 'dir')).toBe(true);
  });

  it('compares observable fields for parity without overfitting internal metadata', async () => {
    const expected: MemoryRecord = {
      ...records[0],
      metadata: { ...records[0].metadata, sourcePath: 'fixtures/sprint-19-search-ranking-fixtures.json' },
    };
    const actual: MemoryRecord = {
      ...records[0],
      provenance: { ...records[0].provenance, origin: 'search-index' },
    };

    expect(compareRecords(expected, actual)).toEqual([]);
  });
});
