import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { main } from '../src/cli.js';
import { openFileSearchDb, resolveDefaultFileSearchDbPath } from '../src/file-search-db.js';
import { searchIndex as searchFileIndex } from '../src/file-search-query.js';
import { listFileSearchProjects, markFileSearchProjectSeen, registerFileSearchProject, unregisterFileSearchProject } from '../src/file-search-project-registry.js';
import { openNativeStore } from '../src/store.js';

function tempDir(prefix = 'byomem-s37-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cliJson(spy: ReturnType<typeof vi.spyOn<typeof console, 'log'>>): any {
  return JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'));
}

describe('Sprint 37 file-search project registry', () => {
  const dirs: string[] = [];
  const originalRuntimeBase = process.env.BYOMEM_RUNTIME_BASE_DIR;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    if (originalRuntimeBase === undefined) delete process.env.BYOMEM_RUNTIME_BASE_DIR;
    else process.env.BYOMEM_RUNTIME_BASE_DIR = originalRuntimeBase;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  function trackedTemp(prefix?: string): string {
    const dir = tempDir(prefix);
    dirs.push(dir);
    return dir;
  }

  function setRuntime(): string {
    const runtimeDir = trackedTemp('byomem-s37-runtime-');
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    return runtimeDir;
  }

  it('creates an empty global registry table without scanning or requiring memories', () => {
    const projectDir = trackedTemp('byomem-s37-project-');
    const runtimeDir = setRuntime();
    writeFileSync(join(projectDir, 'source.txt'), 'registry source body\n', 'utf8');

    const fileDb = openFileSearchDb({ baseDir: projectDir, scanOnOpen: false });
    try {
      expect(fileDb.path).toBe(resolve(runtimeDir, 'byomem-file-search.sqlite'));
      expect(fileDb.path).toBe(resolveDefaultFileSearchDbPath());
      expect(existsSync(join(projectDir, 'byomem-file-search.sqlite'))).toBe(false);
      expect(fileDb.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'file_search_projects'").get()).toBeTruthy();
      expect(listFileSearchProjects(fileDb.db)).toEqual([]);
      expect(fileDb.db.prepare('SELECT COUNT(*) AS count FROM indexed_files').get()).toMatchObject({ count: 0 });
    } finally {
      fileDb.close();
    }
  });

  it('tracks seen, enabled, and disabled states with idempotent explicit registration', () => {
    const projectDir = trackedTemp('byomem-s37-state-project-');
    setRuntime();
    writeFileSync(join(projectDir, 'state.txt'), 'state transition body\n', 'utf8');
    const fileDb = openFileSearchDb({ baseDir: projectDir, scanOnOpen: false });
    try {
      const seen = markFileSearchProjectSeen(fileDb.db, projectDir, 'manual-status');
      expect(seen).toMatchObject({ baseDir: resolve(projectDir), displayName: expect.any(String), state: 'seen', source: 'manual-status' });
      expect(seen.projectKey).toMatch(/^project:/);

      const enabled = registerFileSearchProject(fileDb.db, join(projectDir, '.'));
      expect(enabled).toMatchObject({ projectKey: seen.projectKey, baseDir: resolve(projectDir), state: 'enabled', source: 'manual-register' });
      expect(enabled.registeredAt).toBeTruthy();

      const enabledAgain = registerFileSearchProject(fileDb.db, projectDir);
      expect(enabledAgain).toMatchObject({ projectKey: seen.projectKey, state: 'enabled', source: 'manual-register' });
      expect(listFileSearchProjects(fileDb.db)).toHaveLength(1);

      const disabled = unregisterFileSearchProject(fileDb.db, projectDir);
      expect(disabled).toMatchObject({ projectKey: seen.projectKey, state: 'disabled', source: 'manual-unregister' });
      expect(listFileSearchProjects(fileDb.db)).toHaveLength(1);

      fileDb.scanAndIndex();
      const afterManualScan = listFileSearchProjects(fileDb.db)[0];
      expect(afterManualScan).toMatchObject({ projectKey: seen.projectKey, state: 'disabled', source: 'manual-scan' });
      expect(afterManualScan.lastScanAt).toBeTruthy();
    } finally {
      fileDb.close();
    }
  });

  it('uses collision-safe project keys for same-basename projects and lists all states sorted by base_dir', () => {
    const parentB = trackedTemp('byomem-s37-parent-b-');
    const parentA = trackedTemp('byomem-s37-parent-a-');
    const projectB = join(parentB, 'same-project');
    const projectA = join(parentA, 'same-project');
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    setRuntime();

    const fileDb = openFileSearchDb({ baseDir: projectA, scanOnOpen: false });
    try {
      registerFileSearchProject(fileDb.db, projectB);
      markFileSearchProjectSeen(fileDb.db, projectA, 'manual-search');
      const entries = listFileSearchProjects(fileDb.db);
      expect(entries.map((entry) => entry.baseDir)).toEqual([resolve(projectA), resolve(projectB)].sort((a, b) => a.localeCompare(b)));
      expect(entries.map((entry) => entry.state).sort()).toEqual(['enabled', 'seen']);
      expect(entries[0].projectKey).toMatch(/^project:same-project-[a-f0-9]{12}$/);
      expect(entries[1].projectKey).toMatch(/^project:same-project-[a-f0-9]{12}$/);
      expect(entries[0].projectKey).not.toBe(entries[1].projectKey);
    } finally {
      fileDb.close();
    }
  });

  it('does not infer registry entries from memory writes/searches/prunes or existing memory files', async () => {
    const projectDir = trackedTemp('byomem-s37-memory-project-');
    const runtimeDir = setRuntime();
    writeFileSync(join(projectDir, 'memory-source.txt'), 'memory source body\n', 'utf8');
    writeFileSync(join(projectDir, 'native-store.json'), JSON.stringify({ version: 1, records: [] }), 'utf8');
    writeFileSync(join(projectDir, 'byomem-index.sqlite'), '', 'utf8');
    writeFileSync(join(runtimeDir, 'byomem-file-search.sqlite'), '', 'utf8');

    rmSync(join(runtimeDir, 'byomem-file-search.sqlite'), { force: true });
    const store = openNativeStore({ baseDir: projectDir, fileSearchScanOnOpen: false, embeddingRequireRemote: false });
    try {
      await store.write({ scope: 'project', identity: { namespace: 'sprint-37', leafName: 'Memory Entry', parentContext: 'root' }, content: { text: 'memory only' }, provenance: { source: 'test' } });
      store.prune('project:sprint-37:root:memory-entry');
      expect(listFileSearchProjects(store.fileSearchDb!.db)).toEqual([]);
    } finally {
      store.close();
    }

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

    await main(['store', '--base-dir', projectDir, '--embedding-base-url', 'http://localhost:11434/v1', '--input', JSON.stringify({ scope: 'project', identity: { namespace: 'sprint-37', leafName: 'CLI Memory', parentContext: 'root' }, content: { text: 'cli memory only' }, provenance: { source: 'test' } })]);
    await main(['search', '--base-dir', projectDir, '--query', 'memory']);
    process.exitCode = undefined;
    await main(['prune', '--base-dir', projectDir, '--id', 'project:sprint-37:root:cli-memory']);
    process.exitCode = undefined;

    await main(['file-search-project-list', '--base-dir', projectDir, '--json']);
    expect(cliJson(logSpy)).toMatchObject({ projects: [] });
  });

  it('records seen projects from file-search scan, search, and status without enabling them', async () => {
    const projectDir = trackedTemp('byomem-s37-seen-cli-project-');
    setRuntime();
    writeFileSync(join(projectDir, 'needle.txt'), 'needle seen body\n', 'utf8');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['file-search-status', '--base-dir', projectDir, '--json']);
    await main(['file-search-project-list', '--base-dir', projectDir, '--json']);
    expect(cliJson(logSpy).projects).toEqual([expect.objectContaining({ base_dir: resolve(projectDir), state: 'seen', source: 'manual-status' })]);

    await main(['file-search-scan', '--base-dir', projectDir, '--json']);
    await main(['file-search-project-list', '--base-dir', projectDir, '--json']);
    expect(cliJson(logSpy).projects).toEqual([expect.objectContaining({ base_dir: resolve(projectDir), state: 'seen', source: 'manual-scan', last_scan_at: expect.any(String) })]);

    const store = openNativeStore({ baseDir: projectDir, fileSearchScanOnOpen: false });
    try {
      await searchFileIndex(store, { query: 'needle', mode: 'fts' });
      expect(listFileSearchProjects(store.fileSearchDb!.db)).toEqual([expect.objectContaining({ baseDir: resolve(projectDir), state: 'seen', source: 'manual-search' })]);
    } finally {
      store.close();
    }
  });

  it('supports explicit CLI register/unregister/list without scanning project files', async () => {
    const projectB = trackedTemp('byomem-s37-cli-b-');
    const projectA = trackedTemp('byomem-s37-cli-a-');
    setRuntime();
    writeFileSync(join(projectA, 'a.txt'), 'alpha should not be scanned by register\n', 'utf8');
    writeFileSync(join(projectB, 'b.txt'), 'beta should not be scanned by register\n', 'utf8');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['file-search-project-register', '--base-dir', join(projectB, '.')]);
    expect(cliJson(logSpy)).toMatchObject({ project: { base_dir: resolve(projectB), state: 'enabled', source: 'manual-register', registered_at: expect.any(String) } });
    await main(['file-search-project-register', '--base-dir', projectA]);
    await main(['file-search-project-register', '--base-dir', projectA]);
    await main(['file-search-project-unregister', '--base-dir', projectA]);
    expect(cliJson(logSpy)).toMatchObject({ project: { base_dir: resolve(projectA), state: 'disabled', source: 'manual-unregister' } });

    await main(['file-search-project-list', '--base-dir', projectA, '--json']);
    const projects = cliJson(logSpy).projects;
    expect(projects).toHaveLength(2);
    expect(projects.map((project: { base_dir: string }) => project.base_dir)).toEqual([resolve(projectA), resolve(projectB)].sort((a, b) => a.localeCompare(b)));
    expect(projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ base_dir: resolve(projectA), state: 'disabled' }),
      expect.objectContaining({ base_dir: resolve(projectB), state: 'enabled' }),
    ]));

    const fileDb = openFileSearchDb({ baseDir: projectA, scanOnOpen: false });
    try {
      expect(fileDb.db.prepare('SELECT COUNT(*) AS count FROM indexed_files').get()).toMatchObject({ count: 0 });
      expect(listFileSearchProjects(fileDb.db)).toHaveLength(2);
    } finally {
      fileDb.close();
    }
  });

  it('ships a project-local Pi skill for safe file-search project registration', () => {
    const skillPath = resolve('.pi/skills/file-search-project-registration/SKILL.md');
    expect(existsSync(skillPath)).toBe(true);
    const content = readFileSync(skillPath, 'utf8');
    expect(content).toMatch(/^---\n[\s\S]*name:\s*file-search-project-registration\n[\s\S]*description:\s*.+\n[\s\S]*---/);
    expect(dirname(skillPath).endsWith(join('.pi', 'skills', 'file-search-project-registration'))).toBe(true);
    expect(content).toContain('file-search-project-register --base-dir');
    expect(content).toContain('file-search-project-list --json');
    expect(content).toContain('Do not infer');
    expect(content).toContain('saved memories');
    expect(content).toContain('polling');
  });
});
