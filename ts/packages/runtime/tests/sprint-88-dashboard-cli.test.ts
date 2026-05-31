import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

function expectEmptyRuntimeArtifacts(baseDir: string): void {
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

describe('sprint 88 dashboard CLI boundary', () => {
  const dirs: string[] = [];
  const originalRuntimeBase = process.env.BYOMEM_RUNTIME_BASE_DIR;

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    if (originalRuntimeBase === undefined) delete process.env.BYOMEM_RUNTIME_BASE_DIR;
    else process.env.BYOMEM_RUNTIME_BASE_DIR = originalRuntimeBase;
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('prints dashboard JSON by default without creating runtime artifacts', async () => {
    const runtimeDir = tempDir('byomem-dashboard-runtime-');
    dirs.push(runtimeDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expectEmptyRuntimeArtifacts(runtimeDir);
    await main(['dashboard', '--base-dir', runtimeDir]);

    const payload = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}')) as {
      schemaVersion?: number;
      command?: string;
      runtimeVersion?: string;
      overallStatus?: string;
      statusComponents?: unknown[];
    };

    expect(process.exitCode).toBeUndefined();
    expect(payload).toMatchObject({
      schemaVersion: 1,
      command: 'dashboard',
      runtimeVersion: expect.any(String),
      overallStatus: expect.stringMatching(/^(pass|warn|fail)$/),
      statusComponents: expect.any(Array),
    });
    expectEmptyRuntimeArtifacts(runtimeDir);
  });

  it('prints dashboard JSON when --format json is explicit and leaves an empty runtime directory untouched', async () => {
    const runtimeDir = tempDir('byomem-dashboard-runtime-');
    dirs.push(runtimeDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expectEmptyRuntimeArtifacts(runtimeDir);
    await main(['dashboard', '--base-dir', runtimeDir, '--format', 'json']);

    const payload = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}')) as {
      schemaVersion?: number;
      command?: string;
      generatedAt?: string;
      warnings?: unknown[];
    };

    expect(process.exitCode).toBeUndefined();
    expect(payload).toMatchObject({
      schemaVersion: 1,
      command: 'dashboard',
      generatedAt: expect.any(String),
      warnings: expect.any(Array),
    });
    expectEmptyRuntimeArtifacts(runtimeDir);
  });

  it('writes HTML to --output and reports the write without mutating runtime state', async () => {
    const runtimeDir = tempDir('byomem-dashboard-runtime-');
    const outputRoot = tempDir('byomem-dashboard-output-');
    const outputPath = resolve(outputRoot, 'reports', 'dashboard.html');
    dirs.push(runtimeDir, outputRoot);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    mkdirSync(join(outputRoot, 'reports'), { recursive: true });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expectEmptyRuntimeArtifacts(runtimeDir);
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
    expect(existsSync(outputPath)).toBe(true);
    expect(readFileSync(outputPath, 'utf8')).toContain('<!doctype html>');
    expectEmptyRuntimeArtifacts(runtimeDir);
  });

  it('rejects HTML without output, invalid formats, --output -, extra positional args, and mutating flags before dashboard construction', async () => {
    const runtimeDir = tempDir('byomem-dashboard-runtime-');
    dirs.push(runtimeDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cases = [
      {
        argv: ['dashboard', '--base-dir', runtimeDir, '--format', 'html'],
        error: 'dashboard html output requires --output <path>',
      },
      {
        argv: ['dashboard', '--base-dir', runtimeDir, '--format', 'yaml'],
        error: 'Invalid dashboard format yaml',
      },
      {
        argv: ['dashboard', '--base-dir', runtimeDir, '--format', 'html', '--output', '-'],
        error: 'dashboard does not support --output -',
      },
      {
        argv: ['dashboard', '--base-dir', runtimeDir, 'cleanup'],
        error: 'Unexpected positional argument cleanup after dashboard',
      },
      {
        argv: ['dashboard', '--base-dir', runtimeDir, '--apply'],
        error: 'dashboard is read-only; --apply is not supported',
      },
      {
        argv: ['dashboard', '--base-dir', runtimeDir, '--delete-data'],
        error: 'dashboard is read-only; --delete-data is not supported',
      },
      {
        argv: ['dashboard', '--base-dir', runtimeDir, '--kill-processes'],
        error: 'dashboard is read-only; --kill-processes is not supported',
      },
      {
        argv: ['dashboard', '--base-dir', runtimeDir, '--force'],
        error: 'dashboard is read-only; --force is not supported',
      },
      {
        argv: ['dashboard', '--base-dir', runtimeDir, '--open'],
        error: 'dashboard does not support --open',
      },
      {
        argv: ['dashboard', '--base-dir', runtimeDir, '--serve'],
        error: 'dashboard does not support --serve',
      },
      {
        argv: ['dashboard', '--base-dir', runtimeDir, '--watch'],
        error: 'dashboard does not support --watch',
      },
      {
        argv: ['dashboard', '--base-dir', runtimeDir, '--watch-interval', '1'],
        error: 'dashboard does not support --watch-interval',
      },
      {
        argv: ['dashboard', '--base-dir', runtimeDir, '--refresh'],
        error: 'dashboard does not support --refresh',
      },
      {
        argv: ['dashboard', '--base-dir', runtimeDir, '--scan'],
        error: 'dashboard does not support --scan',
      },
      {
        argv: ['dashboard', '--base-dir', runtimeDir, '--graph-update'],
        error: 'dashboard does not support --graph-update',
      },
      {
        argv: ['dashboard', '--base-dir', runtimeDir, '--cleanup'],
        error: 'dashboard does not support --cleanup',
      },
      {
        argv: ['dashboard', '--base-dir', runtimeDir, '--stop'],
        error: 'dashboard does not support --stop',
      },
    ] as const;

    expectEmptyRuntimeArtifacts(runtimeDir);
    for (const testCase of cases) {
      await main([...testCase.argv]);
      expect(process.exitCode).toBe(1);
      expect(JSON.parse(String(errSpy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
        error: testCase.error,
        command: 'dashboard',
      });
      expectEmptyRuntimeArtifacts(runtimeDir);
      process.exitCode = undefined;
    }
  });
});
