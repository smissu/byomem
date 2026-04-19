import { describe, expect, it } from 'vitest';
import fixtures from '../fixtures/identity-fixtures.json';
import { normalizeStableKey } from '../src/identity.js';

describe('identity fixtures', () => {
  it('match the deterministic stable key contract', () => {
    for (const fixture of fixtures) {
      expect(normalizeStableKey(fixture.scope, fixture.identity)).toBe(fixture.stableKey);
    }
  });
});
