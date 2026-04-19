import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNativeStore } from '../src/store.js';
import { openShadowHarness } from '../src/shadow-harness.js';
import type { MemoryRecord } from '../src/contracts.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-runtime-shadow-'));
}

describe('shadow harness', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('returns the legacy result while keeping native diffs available', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const store = openNativeStore({ baseDir: dir });
    const legacy = {
      id: 'project:byomem:root:shadow-harness',
      scope: 'project' as const,
      provenance: { source: 'fixtures', adapter: 'legacy' },
      identity: { namespace: 'byomem', leafName: 'shadow-harness', parentContext: 'root', stableKey: 'project:byomem:root:shadow-harness' },
      content: { text: 'shadow harness' },
      metadata: { createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z' },
    } satisfies MemoryRecord;
    const harness = openShadowHarness(store, () => legacy);

    const result = await harness.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Shadow Harness', parentContext: 'root' },
      content: { text: 'shadow harness' },
      provenance: { source: 'fixtures' },
    });

    expect(result.legacy?.id).toBe(legacy.id);
    expect(result.native?.id).toBe('project:byomem:root:shadow-harness');
    expect(result.diffs).toEqual([
      { path: 'identity.stableKey', expected: 'project:byomem:root:shadow-harness', actual: null },
    ]);
    expect(store.read('project:byomem:root:shadow-harness')).toBeTruthy();
  });
});
