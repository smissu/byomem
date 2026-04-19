import { describe, expect, it } from 'vitest';
import { openNativeStore } from '../src/store.js';
import { openNativeAdapter } from '../src/adapter.js';
import { openShadowAdapter } from '../src/adapter-shadow.js';
import type { MemoryRecord, WriteIntent } from '../src/contracts.js';

function legacyRead(record: MemoryRecord): () => MemoryRecord {
  return () => ({ ...record, provenance: { ...record.provenance, adapter: 'legacy' } });
}

describe('shadow adapter', () => {
  it('returns legacy output while capturing native diffs', async () => {
    const store = openNativeStore({ baseDir: '/tmp/byomem-shadow-adapter' });
    const adapter = openNativeAdapter(store);
    const intent: WriteIntent = {
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Shadow Adapter', parentContext: 'root' },
      content: { text: 'shadow adapter' },
      provenance: { source: 'fixtures' },
    };

    const legacy = {
      id: 'project:byomem:root:shadow-adapter',
      scope: 'project' as const,
      provenance: { source: 'fixtures', adapter: 'legacy' },
      identity: { namespace: 'byomem', leafName: 'shadow-adapter', parentContext: 'root', stableKey: 'project:byomem:root:shadow-adapter' },
      content: { text: 'shadow adapter' },
      metadata: { createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z' },
    } satisfies MemoryRecord;

    const shadow = openShadowAdapter(adapter, legacyRead(legacy));
    const result = await shadow.write(intent);

    expect(result.legacy?.id).toBe(legacy.id);
    expect(result.native?.id).toBe('project:byomem:root:shadow-adapter');
    expect(result.diffs).toEqual([
      { path: 'identity.stableKey', expected: 'project:byomem:root:shadow-adapter', actual: null },
    ]);
  });
});
