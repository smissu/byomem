import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { main } from '../src/cli.js';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function runtimeArtifacts(baseDir: string): Record<string, boolean> {
  return {
    nativeStoreJson: existsSync(join(baseDir, 'native-store.json')),
    nativeStoreSqlite: existsSync(join(baseDir, 'byomem-index.sqlite')),
    fileSearchSqlite: existsSync(join(baseDir, 'byomem-file-search.sqlite')),
    graphSqlite: existsSync(join(baseDir, 'byomem-graph.sqlite')),
    queueJson: existsSync(join(baseDir, 'queue.json')),
    workerJson: existsSync(join(baseDir, 'worker.json')),
    runtimeStateDir: existsSync(join(baseDir, 'runtime-state')),
  };
}

function expectNoRuntimeArtifacts(baseDir: string): void {
  expect(runtimeArtifacts(baseDir)).toEqual({
    nativeStoreJson: false,
    nativeStoreSqlite: false,
    fileSearchSqlite: false,
    graphSqlite: false,
    queueJson: false,
    workerJson: false,
    runtimeStateDir: false,
  });
}

describe('sprint 92 dashboard CLI boundary', () => {
  const dirs: string[] = [];
  const originalRuntimeBase = process.env.BYOMEM_RUNTIME_BASE_DIR;

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    if (originalRuntimeBase === undefined) delete process.env.BYOMEM_RUNTIME_BASE_DIR;
    else process.env.BYOMEM_RUNTIME_BASE_DIR = originalRuntimeBase;
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('writes JSON dashboard output without creating runtime artifacts', async () => {
    const runtimeDir = tempDir('byomem-dashboard-runtime-');
    dirs.push(runtimeDir);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expectNoRuntimeArtifacts(runtimeDir);
    await main(['dashboard', '--base-dir', runtimeDir]);

    const payload = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}')) as {
      schemaVersion?: number;
      command?: string;
      runtimeVersion?: string;
      overallStatus?: string;
    };

    expect(process.exitCode).toBeUndefined();
    expect(payload).toMatchObject({
      schemaVersion: 1,
      command: 'dashboard',
      runtimeVersion: expect.any(String),
      overallStatus: expect.stringMatching(/^(pass|warn|fail)$/),
    });
    expectNoRuntimeArtifacts(runtimeDir);
  });

  it('omits mutating suggested actions from JSON dashboard surfaces', async () => {
    const runtimeDir = tempDir('byomem-dashboard-runtime-');
    dirs.push(runtimeDir);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['dashboard', '--base-dir', runtimeDir, '--format', 'json']);

    const payload = String(spy.mock.calls.at(-1)?.[0] ?? '{}').toLowerCase();
    expect(payload).not.toContain(' cleanup');
    expect(payload).not.toContain(' stop');
    expect(payload).not.toContain('--apply');
    expect(payload).not.toContain('--delete-data');
    expect(payload).not.toContain('--kill-processes');
    expectNoRuntimeArtifacts(runtimeDir);
  });

  it('writes HTML dashboard output and preserves empty runtime directory', async () => {
    const runtimeDir = tempDir('byomem-dashboard-runtime-');
    const outputRoot = tempDir('byomem-dashboard-output-');
    const outputPath = resolve(outputRoot, 'report', 'dashboard.html');
    dirs.push(runtimeDir, outputRoot);
    mkdirSync(dirname(outputPath), { recursive: true });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expectNoRuntimeArtifacts(runtimeDir);
    await main(['dashboard', '--base-dir', runtimeDir, '--format', 'html', '--output', outputPath]);

    const payload = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}')) as {
      command?: string;
      format?: string;
      outputPath?: string;
      bytesWritten?: number;
    };

    expect(process.exitCode).toBeUndefined();
    expect(payload).toMatchObject({
      command: 'dashboard',
      format: 'html',
      outputPath,
      bytesWritten: expect.any(Number),
    });
    expect(payload).not.toHaveProperty('opened');
    expect(readFileSync(outputPath, 'utf8')).toContain('<!doctype html>');
    expectNoRuntimeArtifacts(runtimeDir);
  });

  it('requires an existing --output parent directory for HTML dashboard output', async () => {
    const runtimeDir = tempDir('byomem-dashboard-runtime-');
    const outputRoot = tempDir('byomem-dashboard-output-');
    const outputPath = join(outputRoot, 'missing', 'dashboard.html');
    dirs.push(runtimeDir, outputRoot);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await main(['dashboard', '--base-dir', runtimeDir, '--format', 'html', '--output', outputPath]);

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(String(errSpy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      error: 'Parent directory for --output must already exist',
      command: 'dashboard',
    });
    expectNoRuntimeArtifacts(runtimeDir);
  });

  it('rejects dashboard mutations and unsupported dashboard flags', async () => {
    const runtimeDir = tempDir('byomem-dashboard-runtime-');
    dirs.push(runtimeDir);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const cases = [
      { argv: ['dashboard', '--base-dir', runtimeDir, '--open'], error: 'dashboard --open requires --format html --output <path>' },
      { argv: ['dashboard', '--base-dir', runtimeDir, '--format', 'json', '--open'], error: 'dashboard --open requires --format html --output <path>' },
      { argv: ['dashboard', '--base-dir', runtimeDir, '--format', 'html', '--open'], error: 'dashboard --open requires --format html --output <path>' },
      { argv: ['dashboard', '--base-dir', runtimeDir, '--format', 'html', '--output', '-', '--open'], error: 'dashboard does not support --output -' },
      { argv: ['dashboard', '--base-dir', runtimeDir, '--serve'], error: 'dashboard does not support --serve' },
      { argv: ['dashboard', '--base-dir', runtimeDir, '--watch'], error: 'dashboard does not support --watch' },
      { argv: ['dashboard', '--base-dir', runtimeDir, '--refresh'], error: 'dashboard does not support --refresh' },
      { argv: ['dashboard', '--base-dir', runtimeDir, '--scan'], error: 'dashboard does not support --scan' },
      { argv: ['dashboard', '--base-dir', runtimeDir, '--graph-update'], error: 'dashboard does not support --graph-update' },
      { argv: ['dashboard', '--base-dir', runtimeDir, '--cleanup'], error: 'dashboard does not support --cleanup' },
      { argv: ['dashboard', '--base-dir', runtimeDir, '--stop'], error: 'dashboard does not support --stop' },
      { argv: ['dashboard', '--base-dir', runtimeDir, '--apply'], error: 'dashboard is read-only; --apply is not supported' },
      { argv: ['dashboard', '--base-dir', runtimeDir, '--delete-data'], error: 'dashboard is read-only; --delete-data is not supported' },
      { argv: ['dashboard', '--base-dir', runtimeDir, '--kill-processes'], error: 'dashboard is read-only; --kill-processes is not supported' },
      { argv: ['dashboard', '--base-dir', runtimeDir, '--force'], error: 'dashboard is read-only; --force is not supported' },
    ];

    for (const testCase of cases) {
      await main(testCase.argv);

      expect(process.exitCode).toBe(1);
      expect(JSON.parse(String(errSpy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
        error: testCase.error,
        command: 'dashboard',
      });
      expectNoRuntimeArtifacts(runtimeDir);
      process.exitCode = undefined;
    }
  });
});
