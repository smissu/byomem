import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNativeStore } from '../src/store.js';
import { openFileSearchDb } from '../src/file-search-db.js';

type FileSearchDbHandle = {
  path: string;
  close: () => void;
  migrate?: () => void;
  db?: { prepare: (sql: string) => { all: (...args: unknown[]) => unknown[]; get: (...args: unknown[]) => unknown } };
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-runtime-sprint-27-'));
}

describe('Sprint 27 file search DB foundation', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it('keeps the file-search DB physically separate from the memories DB', () => {
    const dir = tempDir();
    dirs.push(dir);

    const store = openNativeStore({ baseDir: dir });

    expect(store.sidecar?.path).toMatch(/byomem-index\.sqlite$/);
    const fileDb = (store as unknown as { fileSearchDb?: FileSearchDbHandle }).fileSearchDb;

    expect(fileDb).toBeDefined();
    expect(fileDb?.path).toMatch(/byomem-file-search\.sqlite$/);
    expect(fileDb?.path).not.toBe(store.sidecar?.path);
  });

  it('initializes the file-search schema with project_key partitioning and minimal foundation tables', () => {
    const dir = tempDir();
    dirs.push(dir);

    const store = openNativeStore({ baseDir: dir });
    const fileDb = (store as unknown as { fileSearchDb?: FileSearchDbHandle }).fileSearchDb;

    expect(fileDb).toBeDefined();
    expect(fileDb?.db?.prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name').all('table')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'file_records' }),
        expect.objectContaining({ name: 'schema_meta' }),
      ]),
    );
    expect(fileDb?.db?.prepare("PRAGMA table_info('file_records')").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'id' }),
        expect.objectContaining({ name: 'project_key' }),
        expect.objectContaining({ name: 'path' }),
      ]),
    );
    expect(fileDb?.db?.prepare("PRAGMA index_list('file_records')").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: expect.stringContaining('project_key') }),
      ]),
    );
  });

  it('rejects explicit configuration that points the file-search DB at the memories DB path', () => {
    const dir = tempDir();
    dirs.push(dir);

    expect(() => openFileSearchDb({ baseDir: dir, dbFile: 'byomem-index.sqlite' })).toThrow(/memories DB path/i);
    expect(() => openFileSearchDb({ baseDir: dir, dbFile: 'native-store.json' })).toThrow(/memories DB path/i);
  });

  it('exposes an explicit schema version or migration marker for the file-search DB', () => {
    const dir = tempDir();
    dirs.push(dir);

    const store = openNativeStore({ baseDir: dir });
    const fileDb = (store as unknown as { fileSearchDb?: FileSearchDbHandle }).fileSearchDb;

    expect(fileDb).toBeDefined();
    const markerRows = fileDb?.db?.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND (name LIKE 'schema_%' OR name LIKE '%version%' OR name LIKE '%migrat%') ORDER BY name").all();
    expect(markerRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: expect.stringMatching(/schema|version|migrat/i) }),
      ]),
    );
  });

  it('fails fast on explicit misconfiguration during open/init time', () => {
    const dir = tempDir();
    dirs.push(dir);

    expect(() => openFileSearchDb({ baseDir: dir, dbFile: join(dir, 'byomem-index.sqlite') })).toThrow(/memories DB path/i);
  });
});
