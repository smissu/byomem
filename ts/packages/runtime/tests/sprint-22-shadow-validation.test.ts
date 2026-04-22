import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fixtures from '../fixtures/sprint-22-shadow-validation-fixtures.json';
import type { MemoryRecord } from '../src/contracts.js';
import { openNativeStore } from '../src/store.js';
import { openNativeAdapter } from '../src/adapter.js';
import { openShadowAdapter } from '../src/adapter-shadow.js';
import { openShadowHarness } from '../src/shadow-harness.js';
import { diffRecords } from '../src/shadow-diff.js';
import { resolveRuntimeMode } from '../src/runtime-mode.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-runtime-shadow-validation-'));
}

const storeNative = fixtures.flows.store.nativeRecord as MemoryRecord;
const readExpected = fixtures.flows.read.expected as MemoryRecord;
const readActual = fixtures.flows.read.actual as MemoryRecord;
const writeLegacy = fixtures.flows.write.legacyReturnedRecord as MemoryRecord;
const writeNative = fixtures.flows.write.nativeRecord as MemoryRecord;
const sessionLegacy = fixtures.flows.session.legacyReturnedRecord as MemoryRecord;
const sessionNative = fixtures.flows.session.nativeRecord as MemoryRecord;

describe('Sprint 22 shadow validation slice', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('resolves shadow mode without switching production authority', () => {
    expect(resolveRuntimeMode(fixtures.shadowMode.runtimeMode)).toBe('ts-native-shadow');
    expect(fixtures.shadowMode.legacyReturnAuthority).toBe(true);
    expect(fixtures.shadowMode.nativeIsDiffed).toBe(true);
  });

  it('surfaces only real actionable diffs from shadow comparison fixtures', () => {
    const diffed = diffRecords(fixtures.diffBaseline.record as MemoryRecord, { ...fixtures.diffBaseline.record, content: { text: 'shadow baseline native' }, metadata: { ...fixtures.diffBaseline.record.metadata, updatedAt: '2026-03-01T00:00:01.000Z' } });
    expect(diffed.map((entry) => entry.path)).toEqual(['content.text']);
  });

  it('returns legacy output while native output is diffed in the shadow adapter', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const store = openNativeStore({ baseDir: dir });
    const adapter = openNativeAdapter(store);
    const legacyRead = () => ({ ...writeLegacy, provenance: { ...writeLegacy.provenance, adapter: 'legacy' } });
    const shadow = openShadowAdapter(adapter, legacyRead);

    const result = await shadow.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Sprint 22 Write Alpha', parentContext: 'root' },
      content: { text: 'write shadow' },
      provenance: { source: 'fixtures' },
    });

    expect(result.legacy?.provenance.adapter).toBe('legacy');
    expect(((result.native as { record?: MemoryRecord; provenance?: MemoryRecord['provenance'] } | undefined)?.record?.provenance.adapter ?? (result.native as { record?: MemoryRecord; provenance?: MemoryRecord['provenance'] } | undefined)?.provenance?.adapter)).toBeUndefined();
    expect(result.diffs).toEqual([]);
  });

  it('keeps store and read parity slices stable for the comparison harness', async () => {
    expect(diffRecords(storeNative, { ...storeNative, provenance: { ...storeNative.provenance, adapter: 'legacy' } })).toEqual([]);
    expect(diffRecords(readExpected, readActual)).toEqual([]);
    expect(sessionLegacy.content).toEqual(sessionNative.content);
    expect(sessionLegacy.provenance.adapter).toBe('legacy');
    expect(sessionNative.provenance.adapter).toBe('native-store');
    expect(fixtures.flows.search).toEqual({
      query: 'shadow parity',
      legacyMatches: ['project:byomem:root:sprint-22-search-alpha'],
      nativeMatches: ['project:byomem:root:sprint-22-search-alpha'],
    });
  });

  it('executes the shadow harness and preserves legacy authority', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const store = openNativeStore({ baseDir: dir });
    const legacy = () => writeLegacy;
    const harness = openShadowHarness(store, legacy);

    const result = await harness.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Sprint 22 Write Alpha', parentContext: 'root' },
      content: { text: 'write shadow' },
      provenance: { source: 'fixtures' },
    });

    expect(result.legacy?.id).toBe(writeLegacy.id);
    expect(result.native?.record?.id ?? result.native?.id).toBe(writeNative.id);
    expect(result.diffs).toEqual([]);
  });
});
