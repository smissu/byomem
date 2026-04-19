import { describe, expect, it } from 'vitest';
import { loadMemoryRecord } from '../src/loaders.js';
import fixtures from '../fixtures/memory-record.json';

describe('loaders', () => {
  it('loads canonical fixture shapes', () => {
    expect(loadMemoryRecord(fixtures)).toMatchObject({
      id: 'mem_project_alpha',
      scope: 'project',
      provenance: { source: 'docs' },
    });
  });
});
