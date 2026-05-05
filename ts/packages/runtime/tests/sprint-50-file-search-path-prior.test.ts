import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNativeStore } from '../src/store.js';
import { searchIndex } from '../src/file-search-query.js';

type Store = ReturnType<typeof openNativeStore>;

function tempDir(prefix = 'byomem-runtime-sprint-50-path-prior-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('Sprint 50 file-search path prior', () => {
  const dirs: string[] = [];
  const stores: Store[] = [];

  afterEach(() => {
    while (stores.length) stores.pop()?.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('uses repo-relative path/stem enrichment so FTS favors code files over docs for routing queries', async () => {
    const projectDir = tempDir();
    const runtimeDir = tempDir();
    dirs.push(projectDir, runtimeDir);

    mkdirSync(join(projectDir, 'src', 'app', 'router'), { recursive: true });
    mkdirSync(join(projectDir, 'docs'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'app', 'router', 'routing.py'), 'def register_route_handler():\n    return True\n', 'utf8');
    writeFileSync(join(projectDir, 'docs', 'guide.md'), 'routing guide\n', 'utf8');

    const store = openNativeStore({
      baseDir: projectDir,
      fileSearchDbBaseDir: runtimeDir,
      fileSearchScanOnOpen: false,
    });
    stores.push(store);

    store.fileSearchDb?.scanAndIndex();
    const results = await searchIndex(store, { query: 'routing', mode: 'fts', limit: 5 });

    expect(results).not.toHaveLength(0);
    expect(results[0]?.file?.path).toContain('src/app/router/routing.py');
  });
});
