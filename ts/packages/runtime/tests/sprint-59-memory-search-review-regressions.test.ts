import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchIndex } from '../src/search-index.js';
import { openNativeStore } from '../src/store.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-sprint-59-review-'));
}

describe('Sprint 59 memory search review regressions', () => {
  const dirs: string[] = [];
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
  });

  it('migrates legacy native-store JSON records before searching', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'native-store.json'), `${JSON.stringify({
      version: 1,
      records: [
        {
          id: 'project:byomem:root:legacy-json',
          scope: 'project',
          identity: { namespace: 'byomem', leafName: 'legacy-json', parentContext: 'root' },
          provenance: { source: 'legacy-fixture' },
          content: { text: 'legacy json searchable marker' },
        },
      ],
    }, null, 2)}\n`, 'utf8');

    const store = openNativeStore({ baseDir: dir, embeddingModel: 'fallback-deterministic-v1' });
    expect(store.list()).toHaveLength(1);
    expect(store.sidecar?.list()).toHaveLength(1);
    expect(existsSync(join(dir, 'native-store.json'))).toBe(false);
    expect(existsSync(join(dir, 'native-store.json.migrated'))).toBe(true);
    expect((await searchIndex(store, { query: 'legacy json searchable', mode: 'bm25', limit: 5 }))[0]?.id).toBe('project:byomem:root:legacy-json');
    store.close();
  });

  it('does not leave sidecar-only orphan records when optional remote embedding fails', async () => {
    const dir = tempDir();
    dirs.push(dir);
    globalThis.fetch = (async () => {
      throw new Error('embedding provider unavailable');
    }) as typeof fetch;
    const store = openNativeStore({
      baseDir: dir,
      embeddingBaseUrl: 'http://localhost:11434',
      embeddingModel: 'optional-remote',
      embeddingRequireRemote: false,
    });

    const record = await store.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Optional Remote', parentContext: 'Root' },
      content: { text: 'optional remote write remains consistent' },
      provenance: { source: 'fixtures' },
    });

    expect(store.list().map((entry) => entry.id)).toContain(record.id);
    expect(store.sidecar?.list().map((entry) => entry.id)).toContain(record.id);
    expect((await searchIndex(store, { query: 'optional remote write', mode: 'bm25', limit: 5 }))[0]?.id).toBe(record.id);
    store.close();
  });
});
