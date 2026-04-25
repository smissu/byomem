import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { main } from '../src/cli.js';
import { openFileSearchDb, resolveDefaultFileSearchDbPath } from '../src/file-search-db.js';
import { searchIndex as searchFileIndex } from '../src/file-search-query.js';
import { openNativeStore } from '../src/store.js';

function tempDir(prefix = 'byomem-sprint-36-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('Sprint 36 global file-search DB decoupling', () => {
  const dirs: string[] = [];
  const originalRuntimeBase = process.env.BYOMEM_RUNTIME_BASE_DIR;

  afterEach(() => {
    if (originalRuntimeBase === undefined) delete process.env.BYOMEM_RUNTIME_BASE_DIR;
    else process.env.BYOMEM_RUNTIME_BASE_DIR = originalRuntimeBase;
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  function trackedTemp(prefix?: string): string {
    const dir = tempDir(prefix);
    dirs.push(dir);
    return dir;
  }

  it('resolves the default physical file-search DB under BYOMEM_RUNTIME_BASE_DIR, not the scanned project', () => {
    const projectDir = trackedTemp('byomem-s36-project-');
    const runtimeDir = trackedTemp('byomem-s36-runtime-');
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    writeFileSync(join(projectDir, 'alpha.txt'), 'alpha default global\n', 'utf8');

    const fileDb = openFileSearchDb({ baseDir: projectDir });
    try {
      expect(fileDb.path).toBe(resolve(runtimeDir, 'byomem-file-search.sqlite'));
      expect(fileDb.path).toBe(resolveDefaultFileSearchDbPath());
      expect(existsSync(fileDb.path)).toBe(true);
      expect(existsSync(join(projectDir, 'byomem-file-search.sqlite'))).toBe(false);
    } finally {
      fileDb.close();
    }
  });

  it('keeps scan root, project_key, and scanner status based on the project directory while DB storage is elsewhere', () => {
    const projectDir = trackedTemp('byomem-s36-scan-root-');
    const runtimeDir = trackedTemp('byomem-s36-runtime-');
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    writeFileSync(join(projectDir, 'scan-root.txt'), 'scan root sentinel\n', 'utf8');

    const fileDb = openFileSearchDb({ baseDir: projectDir });
    try {
      const status = fileDb.getScannerStatus();
      expect(status).toMatchObject({ state: 'completed', baseDir: resolve(projectDir), database: expect.objectContaining({ indexedFiles: 1 }) });
      expect(status.projectKey).toMatch(/^project:/);
      expect(status.projectKey).not.toContain(runtimeDir);
      expect(fileDb.path).toBe(resolve(runtimeDir, 'byomem-file-search.sqlite'));
      expect(fileDb.db.prepare('SELECT path FROM indexed_files WHERE project_key = ?').all(status.projectKey)).toEqual([
        expect.objectContaining({ path: join(projectDir, 'scan-root.txt') }),
      ]);
    } finally {
      fileDb.close();
    }
  });

  it('partitions two project scans in one global DB and scopes queries/status to the requested project', async () => {
    const parentA = trackedTemp('byomem-s36-parent-a-');
    const parentB = trackedTemp('byomem-s36-parent-b-');
    const projectA = join(parentA, 'same-project');
    const projectB = join(parentB, 'same-project');
    const runtimeDir = trackedTemp('byomem-s36-runtime-');
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    writeFileSync(join(projectA, 'a.txt'), 'alpha unique only in project a\n', 'utf8');
    writeFileSync(join(projectB, 'b.txt'), 'beta unique only in project b\n', 'utf8');

    const storeA = openNativeStore({ baseDir: projectA, fileSearchDbBaseDir: runtimeDir });
    const storeB = openNativeStore({ baseDir: projectB, fileSearchDbBaseDir: runtimeDir });
    try {
      expect(storeA.fileSearchDb?.path).toBe(storeB.fileSearchDb?.path);
      expect(storeA.fileSearchDb?.path).toBe(resolve(runtimeDir, 'byomem-file-search.sqlite'));
      const statusA = storeA.fileSearchDb!.getScannerStatus();
      const statusB = storeB.fileSearchDb!.getScannerStatus();
      expect(statusA.baseDir).toBe(resolve(projectA));
      expect(statusB.baseDir).toBe(resolve(projectB));
      expect(statusA.projectKey).not.toBe(statusB.projectKey);
      expect(statusA.projectKey).toMatch(/^project:same-project-[a-f0-9]{12}$/);
      expect(statusB.projectKey).toMatch(/^project:same-project-[a-f0-9]{12}$/);

      const aAlpha = await searchFileIndex(storeA, { query: 'alpha', mode: 'fts' });
      const aBeta = await searchFileIndex(storeA, { query: 'beta', mode: 'fts' });
      const bBeta = await searchFileIndex(storeB, { query: 'beta', mode: 'fts' });
      expect(aAlpha).toHaveLength(1);
      expect(aAlpha[0].file?.path).toContain('a.txt');
      expect(aBeta).toHaveLength(0);
      expect(bBeta).toHaveLength(1);
      expect(bBeta[0].file?.path).toContain('b.txt');
    } finally {
      storeA.close();
      storeB.close();
    }
  });

  it('file-search CLI uses global DB storage by default and does not create a project-local DB', async () => {
    const projectDir = trackedTemp('byomem-s36-cli-project-');
    const runtimeDir = trackedTemp('byomem-s36-cli-runtime-');
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    writeFileSync(join(projectDir, 'cli.txt'), 'cli global sentinel\n', 'utf8');

    vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['file-search-scan', '--base-dir', projectDir, '--json']);

    expect(existsSync(resolve(runtimeDir, 'byomem-file-search.sqlite'))).toBe(true);
    expect(existsSync(join(projectDir, 'byomem-file-search.sqlite'))).toBe(false);
  });

  it('supports explicit DB storage overrides while preserving memories-DB guards', () => {
    const projectDir = trackedTemp('byomem-s36-override-project-');
    const dbDir = trackedTemp('byomem-s36-override-db-');
    writeFileSync(join(projectDir, 'override.txt'), 'override sentinel\n', 'utf8');

    const fileDb = openFileSearchDb({ baseDir: projectDir, dbBaseDir: dbDir, dbFile: 'legacy-local.sqlite' });
    try {
      expect(fileDb.path).toBe(resolve(dbDir, 'legacy-local.sqlite'));
      expect(fileDb.getScannerStatus().baseDir).toBe(resolve(projectDir));
    } finally {
      fileDb.close();
    }

    expect(() => openFileSearchDb({ baseDir: projectDir, dbFile: 'byomem-index.sqlite' })).toThrow(/memories DB path/i);
    expect(() => openFileSearchDb({ baseDir: projectDir, dbFile: join(projectDir, 'native-store.json') })).toThrow(/memories DB path/i);
  });

  it('does not create project-local or global DB files when file-search validation fails before store open', async () => {
    const projectDir = trackedTemp('byomem-s36-invalid-project-');
    const runtimeDir = trackedTemp('byomem-s36-invalid-runtime-');
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    writeFileSync(join(projectDir, 'invalid.txt'), 'invalid sentinel\n', 'utf8');

    vi.spyOn(console, 'error').mockImplementation(() => {});

    await main(['file-search', '--base-dir', projectDir, '--mode', 'fts']);
    expect(existsSync(join(projectDir, 'byomem-file-search.sqlite'))).toBe(false);
    expect(existsSync(resolve(runtimeDir, 'byomem-file-search.sqlite'))).toBe(false);

    process.exitCode = undefined;
    await main(['file-search', '--base-dir', projectDir, '--query', 'invalid', '--mode', 'nope']);
    expect(existsSync(join(projectDir, 'byomem-file-search.sqlite'))).toBe(false);
    expect(existsSync(resolve(runtimeDir, 'byomem-file-search.sqlite'))).toBe(false);
  });
});
