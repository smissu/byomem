import { describe, expect, it } from 'vitest';
import { diffRecords } from '../src/shadow-diff.js';
import type { MemoryRecord } from '../src/contracts.js';

const base: MemoryRecord = {
  id: 'project:byomem:root:shadow-alpha',
  scope: 'project',
  provenance: { source: 'fixtures', adapter: 'legacy' },
  identity: { namespace: 'byomem', leafName: 'shadow-alpha', parentContext: 'root', stableKey: 'project:byomem:root:shadow-alpha' },
  content: { text: 'shadow baseline' },
  metadata: { createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z' },
};

describe('shadow diff', () => {
  it('ignores provenance-only changes and reports structured differences', () => {
    expect(diffRecords(base, { ...base, provenance: { ...base.provenance, adapter: 'native-store' } })).toEqual([]);
    expect(diffRecords(base, { ...base, content: { structured: { answer: 'native' } } })).toEqual([
      { path: 'content.text', expected: 'shadow baseline', actual: null },
      { path: 'content.structured', expected: null, actual: { answer: 'native' } },
    ]);
  });
});
