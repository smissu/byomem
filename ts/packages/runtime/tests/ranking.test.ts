import { describe, expect, it } from 'vitest';
import { rankRecords } from '../src/ranking.js';
import type { MemoryRecord } from '../src/contracts.js';
import fixtures from '../fixtures/sprint-19-search-ranking-fixtures.json';

const records = fixtures.records as MemoryRecord[];

describe('ranking baseline', () => {
  it('sorts by deterministic baseline signals and deduplicates by record id', () => {
    const ranked = rankRecords(records, 'alpha lexical only', 'hybrid');
    const ids = ranked.map((entry) => entry.record.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe('project:byomem:root:alpha-lexical');
    expect(ids).toContain('project:byomem:root:alpha-semantic');
  });

  it('returns explicit lexical and semantic signals', () => {
    const ranked = rankRecords(records, 'alpha semantic rerank', 'semantic')[0];
    expect(ranked.signals.lexical).toBeGreaterThanOrEqual(0);
    expect(ranked.signals.semantic).toBeGreaterThanOrEqual(0);
    expect(ranked.score).toBeGreaterThanOrEqual(ranked.signals.semantic);
  });
});
