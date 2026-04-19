import { describe, expect, it } from 'vitest';
import { normalizeIdentity, normalizeLeafName } from '../src/normalizers.js';

describe('normalizers', () => {
  it('normalizes leaf names', () => {
    expect(normalizeLeafName('Project Alpha')).toBe('project-alpha');
  });

  it('normalizes identity shapes', () => {
    expect(
      normalizeIdentity({ namespace: ' byomem ', leafName: 'Project Alpha', parentContext: ' root ' }),
    ).toEqual({ namespace: 'byomem', leafName: 'project-alpha', parentContext: 'root' });
  });
});
