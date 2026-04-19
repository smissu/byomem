import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSharedCorpusStore, searchIndex } from '../src/index.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-runtime-shared-corpus-'));
}

describe('shared corpus slice', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it('loads search-visible records from an existing records.jsonl corpus', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const corpusDir = join(dir, 'native');
    const corpusFile = join(corpusDir, 'records.jsonl');
    mkdirSync(corpusDir, { recursive: true });
    writeFileSync(
      corpusFile,
      [
        JSON.stringify({
          id: 'project:byomem:root:shared-corpus-alpha',
          scope: 'project',
          identity: { namespace: 'byomem', leafName: 'shared-corpus-alpha', parentContext: 'root' },
          content: { text: 'shared corpus alpha baseline' },
          provenance: { source: 'fixtures', adapter: 'jsonl' },
        }),
        JSON.stringify({
          id: 'project:byomem:root:shared-corpus-beta',
          scope: 'project',
          identity: { namespace: 'byomem', leafName: 'shared-corpus-beta', parentContext: 'root' },
          content: { text: 'shared corpus beta baseline' },
          provenance: { source: 'fixtures', adapter: 'jsonl' },
        }),
        JSON.stringify({
          id: 'project:byomem:root:shared-corpus-tombstone',
          scope: 'project',
          lifecycle: 'deleted',
          identity: { namespace: 'byomem', leafName: 'shared-corpus-tombstone', parentContext: 'root' },
          content: { text: 'deleted record' },
          provenance: { source: 'fixtures', adapter: 'jsonl' },
        }),
      ].join('\n') + '\n',
      'utf8',
    );

    const store = openSharedCorpusStore({ baseDir: dir });
    const results = await searchIndex(store, { query: 'shared corpus', scope: 'project' });

    expect(results.map((record) => record.id)).toEqual([
      'project:byomem:root:shared-corpus-alpha',
      'project:byomem:root:shared-corpus-beta',
    ]);
    expect(store.read('project:byomem:root:shared-corpus-tombstone')).toBeUndefined();
  });

  it('normalizes string content rows into searchable records', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const corpusDir = join(dir, 'native');
    const corpusFile = join(corpusDir, 'records.jsonl');
    mkdirSync(corpusDir, { recursive: true });
    writeFileSync(
      corpusFile,
      JSON.stringify({
        id: 'project:byomem:root:runtime-smoke-note',
        scope: 'project',
        identity: { namespace: 'byomem', leafName: 'runtime-smoke-note', parentContext: 'root' },
        content: 'runtime smoke note',
        provenance: { source: 'fixtures', adapter: 'jsonl' },
      }) + '\n',
      'utf8',
    );

    const store = openSharedCorpusStore({ baseDir: dir });
    const results = await searchIndex(store, { query: 'runtime smoke note', scope: 'project' });

    expect(results.map((record) => record.id)).toEqual(['project:byomem:root:runtime-smoke-note']);
    expect(results[0].content.text).toBe('runtime smoke note');
  });

  it('excludes pruned records from active search results', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const corpusDir = join(dir, 'native');
    const corpusFile = join(corpusDir, 'records.jsonl');
    mkdirSync(corpusDir, { recursive: true });
    writeFileSync(
      corpusFile,
      JSON.stringify({
        id: 'project:byomem:root:shared-corpus-alpha',
        scope: 'project',
        identity: { namespace: 'byomem', leafName: 'shared-corpus-alpha', parentContext: 'root' },
        content: { text: 'shared corpus alpha baseline' },
        provenance: { source: 'fixtures', adapter: 'jsonl' },
      }) + '\n',
      'utf8',
    );

    const store = openSharedCorpusStore({ baseDir: dir });
    const removed = store.prune('project:byomem:root:shared-corpus-alpha');

    expect(removed?.id).toBe('project:byomem:root:shared-corpus-alpha');
    expect(await searchIndex(store, { query: 'shared corpus', scope: 'project' })).toHaveLength(0);
  });
});
