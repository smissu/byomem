import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { main } from '../src/cli.js';
import { createDashboardOpener, DashboardOpenUnsupportedPlatformError } from '../src/dashboard-open.js';

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

describe('sprint 94 dashboard open', () => {
  const dirs: string[] = [];
  const originalRuntimeBase = process.env.BYOMEM_RUNTIME_BASE_DIR;

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    if (originalRuntimeBase === undefined) delete process.env.BYOMEM_RUNTIME_BASE_DIR;
    else process.env.BYOMEM_RUNTIME_BASE_DIR = originalRuntimeBase;
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('maps macOS and Linux to the expected no-shell opener commands', async () => {
    const darwinCalls: Array<{ command: string; args: string[] }> = [];
    const linuxCalls: Array<{ command: string; args: string[] }> = [];

    const darwinOpener = createDashboardOpener({
      platform: 'darwin',
      runCommand: async (command, args) => {
        darwinCalls.push({ command, args });
      },
    });
    const linuxOpener = createDashboardOpener({
      platform: 'linux',
      runCommand: async (command, args) => {
        linuxCalls.push({ command, args });
      },
    });

    await darwinOpener('/tmp/byomem-dashboard.html');
    await linuxOpener('/tmp/byomem-dashboard.html');

    expect(darwinCalls).toEqual([{ command: 'open', args: ['/tmp/byomem-dashboard.html'] }]);
    expect(linuxCalls).toEqual([{ command: 'xdg-open', args: ['/tmp/byomem-dashboard.html'] }]);
  });

  it('rejects unsupported platforms with a clear error', async () => {
    const opener = createDashboardOpener({
      platform: 'win32',
      runCommand: async () => {
        throw new Error('must not be called on win32');
      },
    });

    await expect(opener('/tmp/byomem-dashboard.html')).rejects.toBeInstanceOf(DashboardOpenUnsupportedPlatformError);
    await expect(opener('/tmp/byomem-dashboard.html')).rejects.toMatchObject({
      message: 'dashboard --open is not supported on win32',
      code: 'UNSUPPORTED_DASHBOARD_OPEN_PLATFORM',
      platform: 'win32',
    });
  });

  it('writes HTML, opens the exact resolved file, and marks the write report as opened', async () => {
    const runtimeDir = tempDir('byomem-dashboard-runtime-');
    const outputRoot = tempDir('byomem-dashboard-output-');
    const outputPath = resolve(outputRoot, 'reports', 'dashboard.html');
    dirs.push(runtimeDir, outputRoot);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    mkdirSync(join(outputRoot, 'reports'), { recursive: true });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const openCalls: string[] = [];

    await main(['dashboard', '--base-dir', runtimeDir, '--format', 'html', '--output', outputPath, '--open'], {
      createDashboardOpener: () => async (resolvedOutputPath: string) => {
        openCalls.push(resolvedOutputPath);
      },
    });

    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}')) as {
      command?: string;
      format?: string;
      outputPath?: string;
      bytesWritten?: number;
      opened?: boolean;
    };

    expect(process.exitCode).toBeUndefined();
    expect(payload).toMatchObject({
      command: 'dashboard',
      format: 'html',
      outputPath,
      bytesWritten: expect.any(Number),
      opened: true,
    });
    expect(openCalls).toEqual([outputPath]);
    expect(existsSync(outputPath)).toBe(true);
    expect(readFileSync(outputPath, 'utf8')).toContain('<!doctype html>');
    expectNoRuntimeArtifacts(runtimeDir);
  });

  it('omits opened from the HTML write report when --open is not requested', async () => {
    const runtimeDir = tempDir('byomem-dashboard-runtime-');
    const outputRoot = tempDir('byomem-dashboard-output-');
    const outputPath = resolve(outputRoot, 'dashboard.html');
    dirs.push(runtimeDir, outputRoot);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const openerFactory = vi.fn(() => async () => {
      throw new Error('opener must not be called');
    });

    await main(['dashboard', '--base-dir', runtimeDir, '--format', 'html', '--output', outputPath], {
      createDashboardOpener: openerFactory,
    });

    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}')) as {
      command?: string;
      format?: string;
      outputPath?: string;
      bytesWritten?: number;
      opened?: boolean;
    };

    expect(process.exitCode).toBeUndefined();
    expect(payload).toMatchObject({
      command: 'dashboard',
      format: 'html',
      outputPath,
      bytesWritten: expect.any(Number),
    });
    expect(payload).not.toHaveProperty('opened');
    expect(openerFactory).not.toHaveBeenCalled();
    expect(existsSync(outputPath)).toBe(true);
    expectNoRuntimeArtifacts(runtimeDir);
  });

  it('returns a structured error when the opener fails after the HTML file has been written', async () => {
    const runtimeDir = tempDir('byomem-dashboard-runtime-');
    const outputRoot = tempDir('byomem-dashboard-output-');
    const outputPath = resolve(outputRoot, 'dashboard.html');
    dirs.push(runtimeDir, outputRoot);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    mkdirSync(outputRoot, { recursive: true });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const openerError = Object.assign(new Error('xdg-open exited with code 1'), {
      code: 'ENOENT',
      command: 'xdg-open',
      exitCode: 1,
      signal: null,
    });

    await main(['dashboard', '--base-dir', runtimeDir, '--format', 'html', '--output', outputPath, '--open'], {
      createDashboardOpener: () => async () => {
        throw openerError;
      },
    });

    const payload = JSON.parse(String(errSpy.mock.calls.at(-1)?.[0] ?? '{}')) as {
      error?: string;
      command?: string;
      format?: string;
      outputPath?: string;
      bytesWritten?: number;
      opened?: boolean;
      opener?: { name?: string; message?: string; code?: string; command?: string; exitCode?: number; signal?: string | null };
    };

    expect(process.exitCode).toBe(1);
    expect(payload).toMatchObject({
      error: 'xdg-open exited with code 1',
      command: 'dashboard',
      format: 'html',
      outputPath,
      bytesWritten: expect.any(Number),
      opened: false,
      opener: expect.objectContaining({
        message: 'xdg-open exited with code 1',
        code: 'ENOENT',
        command: 'xdg-open',
        exitCode: 1,
        signal: null,
      }),
    });
    expect(existsSync(outputPath)).toBe(true);
    expect(readFileSync(outputPath, 'utf8')).toContain('<!doctype html>');
    expectNoRuntimeArtifacts(runtimeDir);
  });

  it('returns a structured opened-false error when the HTML write fails before opening', async () => {
    const runtimeDir = tempDir('byomem-dashboard-runtime-');
    const outputRoot = tempDir('byomem-dashboard-output-');
    const outputPath = resolve(outputRoot, 'dashboard-directory');
    dirs.push(runtimeDir, outputRoot);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    mkdirSync(outputPath, { recursive: true });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const openerFactory = vi.fn(() => async () => {
      throw new Error('opener must not be called');
    });

    await main(['dashboard', '--base-dir', runtimeDir, '--format', 'html', '--output', outputPath, '--open'], {
      createDashboardOpener: openerFactory,
    });

    const payload = JSON.parse(String(errSpy.mock.calls.at(-1)?.[0] ?? '{}')) as {
      error?: string;
      command?: string;
      format?: string;
      outputPath?: string;
      bytesWritten?: number;
      opened?: boolean;
      write?: { name?: string; message?: string; code?: string };
    };

    expect(process.exitCode).toBe(1);
    expect(payload).toMatchObject({
      command: 'dashboard',
      format: 'html',
      outputPath,
      bytesWritten: 0,
      opened: false,
      write: expect.objectContaining({
        name: expect.any(String),
        message: expect.any(String),
      }),
    });
    expect(openerFactory).not.toHaveBeenCalled();
    expectNoRuntimeArtifacts(runtimeDir);
  });

  it('rejects invalid open shapes before dashboard construction, file writes, or opener calls', async () => {
    const runtimeDir = tempDir('byomem-dashboard-runtime-');
    dirs.push(runtimeDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const openerFactory = vi.fn(() => async () => {
      throw new Error('opener must not be called');
    });
    const cases = [
      {
        argv: ['dashboard', '--base-dir', runtimeDir, '--open'],
        error: 'dashboard --open requires --format html --output <path>',
      },
      {
        argv: ['dashboard', '--base-dir', runtimeDir, '--format', 'json', '--open'],
        error: 'dashboard --open requires --format html --output <path>',
      },
      {
        argv: ['dashboard', '--base-dir', runtimeDir, '--format', 'html', '--open'],
        error: 'dashboard --open requires --format html --output <path>',
      },
      {
        argv: ['dashboard', '--base-dir', runtimeDir, '--format', 'html', '--output', '-', '--open'],
        error: 'dashboard does not support --output -',
      },
    ] as const;

    for (const testCase of cases) {
      await main([...testCase.argv], {
        createDashboardOpener: openerFactory,
      });

      expect(process.exitCode).toBe(1);
      expect(JSON.parse(String(errSpy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
        error: testCase.error,
        command: 'dashboard',
      });
      expect(openerFactory).not.toHaveBeenCalled();
      expectNoRuntimeArtifacts(runtimeDir);
      process.exitCode = undefined;
    }
  });

  it('returns a clear unsupported-platform JSON error after writing HTML', async () => {
    const runtimeDir = tempDir('byomem-dashboard-runtime-');
    const outputRoot = tempDir('byomem-dashboard-output-');
    const outputPath = resolve(outputRoot, 'dashboard.html');
    dirs.push(runtimeDir, outputRoot);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    mkdirSync(outputRoot, { recursive: true });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await main(['dashboard', '--base-dir', runtimeDir, '--format', 'html', '--output', outputPath, '--open'], {
      createDashboardOpener: () => createDashboardOpener({ platform: 'win32' }),
    });

    const payload = JSON.parse(String(errSpy.mock.calls.at(-1)?.[0] ?? '{}')) as {
      error?: string;
      command?: string;
      format?: string;
      outputPath?: string;
      bytesWritten?: number;
      opened?: boolean;
      opener?: { name?: string; message?: string; code?: string; platform?: string };
    };

    expect(process.exitCode).toBe(1);
    expect(payload).toMatchObject({
      error: 'dashboard --open is not supported on win32',
      command: 'dashboard',
      format: 'html',
      outputPath,
      bytesWritten: expect.any(Number),
      opened: false,
      opener: expect.objectContaining({
        name: 'DashboardOpenUnsupportedPlatformError',
        message: 'dashboard --open is not supported on win32',
        code: 'UNSUPPORTED_DASHBOARD_OPEN_PLATFORM',
        platform: 'win32',
      }),
    });
    expect(existsSync(outputPath)).toBe(true);
    expect(readFileSync(outputPath, 'utf8')).toContain('<!doctype html>');
    expectNoRuntimeArtifacts(runtimeDir);
  });
});
