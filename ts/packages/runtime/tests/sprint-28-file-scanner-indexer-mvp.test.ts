import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNativeStore } from '../src/store.js';

type FileSearchDbHandle = {
  path: string;
  close: () => void;
  scanAndIndex?: () => void;
  db?: {
    prepare: (sql: string) => {
      all: (...args: unknown[]) => unknown[];
      get: (...args: unknown[]) => unknown;
      run: (...args: unknown[]) => unknown;
    };
  };
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-runtime-sprint-28-'));
}

describe('Sprint 28 file scanner / indexer MVP', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it('discovers project files and records new indexed entries in the separate file-search DB', () => {
    const dir = tempDir();
    dirs.push(dir);
    mkdirSync(join(dir, 'project'), { recursive: true });
    writeFileSync(join(dir, 'project', 'alpha.md'), 'alpha content\n', 'utf8');

    const store = openNativeStore({ baseDir: dir });
    const fileDb = (store as unknown as { fileSearchDb?: FileSearchDbHandle }).fileSearchDb;

    expect(fileDb).toBeDefined();
    expect(fileDb?.db?.prepare('SELECT * FROM indexed_files').all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: expect.stringContaining('alpha.md') })]),
    );
  });

  it('uses mtime and size as a prefilter before confirming content hashes', () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'beta.txt'), 'beta content\n', 'utf8');

    const store = openNativeStore({ baseDir: dir });
    const fileDb = (store as unknown as { fileSearchDb?: FileSearchDbHandle }).fileSearchDb;

    expect(fileDb).toBeDefined();
    const prefilterRows = fileDb?.db?.prepare('SELECT * FROM scan_prefilter_events').all();
    expect(prefilterRows).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'mtime-size' })]));
    const hashRows = fileDb?.db?.prepare('SELECT * FROM content_hash_checks').all();
    expect(hashRows).toEqual(expect.arrayContaining([expect.objectContaining({ confirmed: 1 })]));
  });

  it('confirms suspected changes with a content hash before treating the file as changed', () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'gamma.txt'), 'gamma v1\n', 'utf8');

    const store = openNativeStore({ baseDir: dir });
    const fileDb = (store as unknown as { fileSearchDb?: FileSearchDbHandle }).fileSearchDb;

    expect(fileDb).toBeDefined();
    fileDb?.scanAndIndex?.();
    writeFileSync(join(dir, 'gamma.txt'), 'gamma v2\n', 'utf8');
    fileDb?.scanAndIndex?.();
    const rows = fileDb?.db?.prepare('SELECT * FROM changed_files').all();
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          change_state: 'confirmed-by-hash',
        }),
      ]),
    );
  });

  it('creates stable indexed chunk output for confirmed file content', () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'delta.txt'), 'delta content\n', 'utf8');

    const store = openNativeStore({ baseDir: dir });
    const fileDb = (store as unknown as { fileSearchDb?: FileSearchDbHandle }).fileSearchDb;

    expect(fileDb).toBeDefined();
    const chunkRows = fileDb?.db?.prepare('SELECT * FROM indexed_chunks').all();
    expect(chunkRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chunk_index: 0,
          chunk_text: expect.any(String),
        }),
      ]),
    );
  });

  it('reconciles new, changed, and deleted files into the project-partitioned index', () => {
    const dir = tempDir();
    dirs.push(dir);
    const filePath = join(dir, 'epsilon.txt');
    writeFileSync(filePath, 'epsilon v1\n', 'utf8');

    const store = openNativeStore({ baseDir: dir });
    const fileDb = (store as unknown as { fileSearchDb?: FileSearchDbHandle }).fileSearchDb;

    expect(fileDb).toBeDefined();
    fileDb?.scanAndIndex?.();
    const initial = fileDb?.db?.prepare('SELECT * FROM reconciled_files').all();
    expect(initial).toEqual(expect.arrayContaining([expect.objectContaining({ reconciliation_state: 'new' })]));

    writeFileSync(filePath, 'epsilon v2\n', 'utf8');
    fileDb?.scanAndIndex?.();
    const changed = fileDb?.db?.prepare('SELECT * FROM reconciled_files').all();
    expect(changed).toEqual(expect.arrayContaining([expect.objectContaining({ reconciliation_state: 'changed' })]));

    rmSync(filePath);
    fileDb?.scanAndIndex?.();
    const deleted = fileDb?.db?.prepare('SELECT * FROM reconciled_files').all();
    expect(deleted).toEqual(expect.arrayContaining([expect.objectContaining({ reconciliation_state: 'deleted' })]));
  });

  it('keeps indexed writes inside the separate file-search DB boundary', () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'zeta.txt'), 'zeta content\n', 'utf8');

    const store = openNativeStore({ baseDir: dir });
    const fileDb = (store as unknown as { fileSearchDb?: FileSearchDbHandle }).fileSearchDb;

    expect(fileDb).toBeDefined();
    expect(() => fileDb?.db?.prepare('SELECT * FROM records').all()).toThrow();
    expect(() => fileDb?.db?.prepare('SELECT * FROM record_embeddings').all()).toThrow();
  });
});
