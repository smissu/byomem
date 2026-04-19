import { describe, expect, it } from 'vitest';
import { normalizeIdentity, normalizeStableKey } from '../src/identity.js';
import { stableIdentityFixtures } from '../src/identity-fixtures.js';

describe('identity normalization', () => {
  it('normalizes identity fields for stable keys', () => {
    const identity = normalizeIdentity('project', {
      namespace: ' BYOMEM ',
      leafName: 'Project Alpha',
      parentContext: ' Root ',
    });

    expect(identity).toEqual({
      namespace: 'byomem',
      leafName: 'project-alpha',
      parentContext: 'root',
      stableKey: 'project:byomem:root:project-alpha',
    });
  });

  it('derives deterministic keys across canonical baseline fixtures', () => {
    for (const fixture of stableIdentityFixtures) {
      expect(normalizeStableKey(fixture.scope, fixture.identity)).toBe(fixture.stableKey);
    }
  });

  it('keeps collision-prone inputs deterministic', () => {
    const a = normalizeStableKey('project', { namespace: 'byomem', leafName: 'Project Alpha', parentContext: 'root' });
    const b = normalizeStableKey('project', { namespace: 'byomem', leafName: 'Project   Alpha', parentContext: 'root ' });
    const c = normalizeStableKey('dir', { namespace: 'byomem', leafName: 'Project Alpha', parentContext: 'root' });
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });
});
