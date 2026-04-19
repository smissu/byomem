import { describe, expect, it } from 'vitest';
import { isCaptureCandidate } from '../src/capture-candidate.js';
import type { MemoryRecord } from '../src/contracts.js';

describe('capture candidate helper', () => {
  it('requires approval gating', () => {
    const record: MemoryRecord = {
      id: 'project:byomem:root:candidate',
      scope: 'project',
      provenance: { source: 'fixtures' },
      identity: { namespace: 'byomem', leafName: 'candidate', parentContext: 'root', stableKey: 'project:byomem:root:candidate' },
      content: { text: 'candidate' },
    };

    expect(isCaptureCandidate(record)).toBe(false);
    expect(isCaptureCandidate(record, true)).toBe(true);
  });
});
