import { describe, expect, it } from 'vitest';
import { compareRecords } from '../src/parity.js';
import type { MemoryRecord } from '../src/contracts.js';

const baseRecord: MemoryRecord = {
  id: 'mem_project_alpha',
  scope: 'project',
  provenance: { source: 'docs' },
  identity: { namespace: 'byomem', leafName: 'project-alpha', parentContext: 'root' },
  content: { text: 'Alpha note' },
};

describe('parity harness skeleton', () => {
  it('returns no diffs for matching records', () => {
    expect(compareRecords(baseRecord, baseRecord)).toEqual([]);
  });

  it('reports foundational metadata diffs', () => {
    const diffs = compareRecords(baseRecord, {
      ...baseRecord,
      id: 'mem_project_beta',
      provenance: { source: 'fixtures' },
      metadata: { sourcePath: 'fixtures/other.json' },
    });

    expect(diffs).toEqual([
      { field: 'id', expected: 'mem_project_alpha', actual: 'mem_project_beta' },
      { field: 'metadata.sourcePath', expected: null, actual: 'fixtures/other.json' },
      { field: 'provenance.source', expected: 'docs', actual: 'fixtures' },
    ]);
  });
});
