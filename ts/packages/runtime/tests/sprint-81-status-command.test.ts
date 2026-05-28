import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { main } from '../src/cli.js';
import { buildByomemStatusReport } from '../src/status-report.js';
import { BYOMEM_RUNTIME_VERSION } from '../src/version.js';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function byomemCliTempDirs(): string[] {
  return readdirSync(tmpdir()).filter((entry) => entry.startsWith('byomem-cli-')).sort();
}

describe('sprint 81 status command', () => {
  const dirs: string[] = [];
  const originalRuntimeBase = process.env.BYOMEM_RUNTIME_BASE_DIR;
  const originalCwd = process.cwd();

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    if (originalRuntimeBase === undefined) delete process.env.BYOMEM_RUNTIME_BASE_DIR;
    else process.env.BYOMEM_RUNTIME_BASE_DIR = originalRuntimeBase;
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('builds a stat-only report with artifact metadata and deterministic process placeholders', () => {
    const runtimeDir = tempDir('byomem-status-runtime-');
    const projectDir = tempDir('byomem-status-project-');
    dirs.push(runtimeDir, projectDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    writeFileSync(join(runtimeDir, 'native-store.json'), '{"version":1,"records":[]}\n', 'utf8');
    writeFileSync(join(runtimeDir, 'byomem-index.sqlite'), 'memory sqlite payload', 'utf8');
    writeFileSync(join(runtimeDir, 'byomem-graph.sqlite'), 'graph sqlite payload', 'utf8');

    const report = buildByomemStatusReport({
      cwd: projectDir,
      projectBaseDir: projectDir,
      runtimeBaseDir: runtimeDir,
      generatedAt: new Date('2026-05-28T12:00:00.000Z'),
    });

    expect(report).toMatchObject({
      version: BYOMEM_RUNTIME_VERSION,
      runtimeVersion: BYOMEM_RUNTIME_VERSION,
      generatedAt: '2026-05-28T12:00:00.000Z',
      projectBaseDir: projectDir,
      runtimeBaseDir: runtimeDir,
      paths: {
        memory: {
          json: join(runtimeDir, 'native-store.json'),
          sqlite: join(runtimeDir, 'byomem-index.sqlite'),
        },
        fileSearch: {
          sqlite: join(runtimeDir, 'byomem-file-search.sqlite'),
        },
        graph: {
          sqlite: join(runtimeDir, 'byomem-graph.sqlite'),
        },
      },
      mcpProcesses: {
        source: 'runtime-state',
        count: 0,
        roles: [],
        staleCount: 0,
      },
    });

    expect(report.artifacts.memory.json).toMatchObject({
      exists: true,
      sizeBytes: expect.any(Number),
      mtime: expect.any(String),
    });
    expect(report.artifacts.memory.sqlite).toMatchObject({
      exists: true,
      sizeBytes: expect.any(Number),
      mtime: expect.any(String),
    });
    expect(report.artifacts.fileSearch.sqlite).toMatchObject({
      exists: false,
      sizeBytes: null,
      mtime: null,
    });
    expect(report.artifacts.graph.sqlite).toMatchObject({
      exists: true,
      sizeBytes: expect.any(Number),
      mtime: expect.any(String),
    });
    expect(report.degradedComponents).toEqual(expect.arrayContaining(['fileSearch']));
    expect(report.warnings).toEqual(expect.arrayContaining([expect.stringContaining('file-search')]));
    expect(report.mcpProcesses.warnings).toEqual([expect.stringContaining('runtime process state directory is missing')]);
  });

  it('prints status JSON without creating missing artifacts', async () => {
    const runtimeDir = tempDir('byomem-status-runtime-');
    const projectDir = tempDir('byomem-status-project-');
    dirs.push(runtimeDir, projectDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    writeFileSync(join(projectDir, 'native-store.json'), '{"version":1,"records":[]}\n', 'utf8');
    writeFileSync(join(projectDir, 'byomem-index.sqlite'), 'memory sqlite payload', 'utf8');

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['status', '--base-dir', projectDir]);

    const report = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}')) as {
      version?: string;
      runtimeVersion?: string;
      projectBaseDir?: string;
      runtimeBaseDir?: string;
      artifacts?: { fileSearch?: { sqlite?: { exists?: boolean } } };
      mcpProcesses?: { source?: string };
    };

    expect(process.exitCode).toBeUndefined();
    expect(report).toMatchObject({
      version: BYOMEM_RUNTIME_VERSION,
      runtimeVersion: BYOMEM_RUNTIME_VERSION,
      projectBaseDir: projectDir,
      runtimeBaseDir: projectDir,
      mcpProcesses: { source: 'runtime-state' },
    });
    expect(report.artifacts?.fileSearch?.sqlite?.exists).toBe(false);
    expect(existsSync(join(projectDir, 'byomem-file-search.sqlite'))).toBe(false);
    expect(existsSync(join(projectDir, 'byomem-graph.sqlite'))).toBe(false);
    expect(existsSync(runtimeDir)).toBe(true);
  });

  it('does not create the parser default temp base dir for status', async () => {
    const runtimeDir = tempDir('byomem-status-runtime-');
    const projectDir = tempDir('byomem-status-project-');
    dirs.push(runtimeDir, projectDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    process.chdir(projectDir);
    const before = byomemCliTempDirs();
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['status']);

    const report = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}')) as {
      projectBaseDir?: string;
      runtimeBaseDir?: string;
    };
    expect(process.exitCode).toBeUndefined();
    expect(report.projectBaseDir).toBe(realpathSync(projectDir));
    expect(report.runtimeBaseDir).toBe(resolve(runtimeDir));
    expect(byomemCliTempDirs()).toEqual(before);
  });

  it('returns a non-zero exit code for invalid status flags', async () => {
    const runtimeDir = tempDir('byomem-status-runtime-');
    const projectDir = tempDir('byomem-status-project-');
    dirs.push(runtimeDir, projectDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await main(['status', '--base-dir']);

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(String(errSpy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      error: 'Missing value for --base-dir',
      command: 'status',
    });
    expect(existsSync(join(runtimeDir, 'byomem-file-search.sqlite'))).toBe(false);
    expect(existsSync(join(runtimeDir, 'byomem-graph.sqlite'))).toBe(false);
  });
});
