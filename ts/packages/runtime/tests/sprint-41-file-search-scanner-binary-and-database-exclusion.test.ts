import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFileSearchDb } from '../src/file-search-db.js';

function tempDir(prefix = 'byomem-runtime-sprint-41-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function openFileDb(
  projectDir: string,
  runtimeDir: string,
  options: Partial<Parameters<typeof openFileSearchDb>[0]> & {
    scannerExcludedExtensions?: string[];
    scannerBinaryDetectionEnabled?: boolean;
  } = {},
) {
  return openFileSearchDb({
    baseDir: projectDir,
    dbBaseDir: runtimeDir,
    scanOnOpen: false,
    schedulerEnabled: false,
    semanticSearchEnabled: false,
    ...options,
  });
}

function indexedPaths(fileDb: ReturnType<typeof openFileSearchDb>): string[] {
  return (fileDb.db.prepare('SELECT path FROM indexed_files ORDER BY path').all() as Array<{ path: string }>).map((row) => row.path);
}

function indexedChunks(fileDb: ReturnType<typeof openFileSearchDb>): string[] {
  return (fileDb.db.prepare('SELECT chunk_text FROM indexed_chunks ORDER BY chunk_text').all() as Array<{ chunk_text: string }>).map((row) => row.chunk_text);
}

describe('Sprint 41 file-search scanner binary and database exclusion contract', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('continues honoring .gitignore while skipping default database extensions before indexing', () => {
    const projectDir = tempDir();
    const runtimeDir = tempDir();
    dirs.push(projectDir, runtimeDir);
    writeFileSync(join(projectDir, '.gitignore'), 'ignored.log\n', 'utf8');
    writeFileSync(join(projectDir, 'keep.md'), 'keep body\n', 'utf8');
    writeFileSync(join(projectDir, 'db'), 'bare db body\n', 'utf8');
    writeFileSync(join(projectDir, 'ignored.log'), 'ignored log body\n', 'utf8');
    writeFileSync(join(projectDir, 'payload.db'), 'payload db body\n', 'utf8');
    writeFileSync(join(projectDir, 'payload.sqlite3'), 'payload sqlite body\n', 'utf8');

    const fileDb = openFileDb(projectDir, runtimeDir);
    try {
      const status = fileDb.scanAndIndex({ trigger: 'manual' });

      expect(indexedPaths(fileDb)).toEqual(expect.arrayContaining([join(projectDir, 'keep.md'), join(projectDir, '.gitignore'), join(projectDir, 'db')]));
      expect(indexedChunks(fileDb)).toEqual(expect.arrayContaining(['keep body', 'bare db body']));
      expect(status.progress).toMatchObject({
        ignoredFiles: expect.any(Number),
        errorFiles: 0,
      });
      expect(status.progress.ignoredFiles).toBeGreaterThanOrEqual(3);
      expect(status.progress.errorFiles).toBe(0);
    } finally {
      fileDb.close();
    }
  });

  it('replaces default extension exclusions with an explicit list and matches case-insensitively', () => {
    const projectDir = tempDir();
    const runtimeDir = tempDir();
    dirs.push(projectDir, runtimeDir);
    writeFileSync(join(projectDir, 'skip.DB'), 'skip db body\n', 'utf8');
    writeFileSync(join(projectDir, 'skip.txt'), 'skip text body\n', 'utf8');
    writeFileSync(join(projectDir, 'keep.sqlite'), 'keep sqlite body\n', 'utf8');

    const fileDb = openFileDb(projectDir, runtimeDir, { scannerExcludedExtensions: ['DB', 'txt'] });
    try {
      const status = fileDb.scanAndIndex({ trigger: 'manual' });

      expect(indexedPaths(fileDb)).toEqual([join(projectDir, 'keep.sqlite')]);
      expect(indexedChunks(fileDb)).toEqual(['keep sqlite body']);
      expect(status.progress.ignoredFiles).toBe(2);
      expect(status.progress.errorFiles).toBe(0);
    } finally {
      fileDb.close();
    }
  });

  it('skips binary files by default before any UTF-8 read fails', () => {
    const projectDir = tempDir();
    const runtimeDir = tempDir();
    dirs.push(projectDir, runtimeDir);
    writeFileSync(join(projectDir, 'keep.txt'), 'keep body\n', 'utf8');
    writeFileSync(join(projectDir, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0x61, 0x62, 0x63]));

    const fileDb = openFileDb(projectDir, runtimeDir);
    try {
      const status = fileDb.scanAndIndex({ trigger: 'manual' });

      expect(indexedPaths(fileDb)).toEqual([join(projectDir, 'keep.txt')]);
      expect(status.progress.ignoredFiles).toBeGreaterThanOrEqual(1);
      expect(status.progress.errorFiles).toBe(0);
    } finally {
      fileDb.close();
    }
  });

  it('indexes binary files when binary detection is explicitly disabled', () => {
    const projectDir = tempDir();
    const runtimeDir = tempDir();
    dirs.push(projectDir, runtimeDir);
    writeFileSync(join(projectDir, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0x61, 0x62, 0x63]));

    const fileDb = openFileDb(projectDir, runtimeDir, { scannerBinaryDetectionEnabled: false });
    try {
      const status = fileDb.scanAndIndex({ trigger: 'manual' });

      expect(indexedPaths(fileDb)).toEqual([join(projectDir, 'binary.bin')]);
      expect(indexedChunks(fileDb).length).toBeGreaterThanOrEqual(1);
      expect(status.progress.ignoredFiles).toBe(0);
      expect(status.progress.errorFiles).toBe(0);
    } finally {
      fileDb.close();
    }
  });

  it('reconciles previously indexed excluded and binary files out of the DB on rescan', () => {
    const projectDir = tempDir();
    const runtimeDir = tempDir();
    dirs.push(projectDir, runtimeDir);
    const excludedPath = join(projectDir, 'artifact.db');
    const binaryPath = join(projectDir, 'binary.bin');
    writeFileSync(excludedPath, 'artifact body\n', 'utf8');
    writeFileSync(binaryPath, Buffer.from([0x00, 0x01, 0x02, 0x61, 0x62, 0x63]));

    const first = openFileDb(projectDir, runtimeDir, { scannerExcludedExtensions: [], scannerBinaryDetectionEnabled: false });
    try {
      const seeded = first.scanAndIndex({ trigger: 'manual' });
      expect(seeded.progress.errorFiles).toBe(0);
      expect(indexedPaths(first)).toEqual(expect.arrayContaining([excludedPath, binaryPath]));
    } finally {
      first.close();
    }

    const second = openFileDb(projectDir, runtimeDir);
    try {
      const reconciled = second.scanAndIndex({ trigger: 'manual' });

      expect(indexedPaths(second)).toEqual([]);
      expect(indexedChunks(second)).toEqual([]);
      expect(reconciled.progress.ignoredFiles).toBeGreaterThanOrEqual(2);
      expect(reconciled.progress.deletedFiles).toBeGreaterThanOrEqual(2);
      expect(reconciled.progress.errorFiles).toBe(0);
      expect(second.db.prepare('SELECT COUNT(*) AS count FROM indexed_files').get()).toMatchObject({ count: 0 });
      expect(second.db.prepare('SELECT COUNT(*) AS count FROM indexed_chunks').get()).toMatchObject({ count: 0 });
      expect(second.db.prepare('SELECT reconciliation_state FROM reconciled_files ORDER BY created_at DESC LIMIT 2').all()).toEqual(
        expect.arrayContaining([expect.objectContaining({ reconciliation_state: 'deleted' })]),
      );
    } finally {
      second.close();
    }
  });
});
