import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { main } from '../src/cli.js';
import { createDashboardServer, type DashboardServerHandle, type DashboardServerOptions } from '../src/dashboard-server.js';

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

function makeClosedServerHandle(options: DashboardServerOptions, closeSpy = vi.fn(async () => {})): DashboardServerHandle {
  const host = options.host ?? '127.0.0.1';
  return {
    host,
    port: options.port ?? 0,
    url: `http://${host}:${options.port ?? 0}/`,
    close: closeSpy,
    waitUntilClosed: async () => {},
  };
}

async function readResponse(url: string): Promise<{ status: number; headers: Headers; text: string }> {
  const response = await fetch(url);
  return {
    status: response.status,
    headers: response.headers,
    text: await response.text(),
  };
}

describe('sprint 98 dashboard serve', () => {
  const dirs: string[] = [];
  const originalRuntimeBase = process.env.BYOMEM_RUNTIME_BASE_DIR;

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    if (originalRuntimeBase === undefined) delete process.env.BYOMEM_RUNTIME_BASE_DIR;
    else process.env.BYOMEM_RUNTIME_BASE_DIR = originalRuntimeBase;
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('routes dashboard --serve --open through an injected server dependency, opens the loopback URL, and emits a serve report', async () => {
    const runtimeDir = tempDir('byomem-dashboard-runtime-');
    const outputRoot = tempDir('byomem-dashboard-output-');
    const outputPath = resolve(outputRoot, 'reports', 'dashboard.html');
    dirs.push(runtimeDir, outputRoot);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    mkdirSync(dirname(outputPath), { recursive: true });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const openTargets: string[] = [];
    const serverOptions: DashboardServerOptions[] = [];

    await main(
      ['dashboard', '--base-dir', runtimeDir, '--format', 'html', '--output', outputPath, '--serve', '--open'],
      {
        createDashboardOpener: () => async (target) => {
          openTargets.push(target);
        },
        createDashboardServer: async (options) => {
          serverOptions.push(options);
          return makeClosedServerHandle({ ...options, port: 48211 });
        },
      },
    );

    expect(process.exitCode).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(serverOptions).toHaveLength(1);
    expect(serverOptions[0]).toMatchObject({
      outputPath,
      host: '127.0.0.1',
      port: 0,
    });
    expect(serverOptions[0]!.html).toContain('<!doctype html>');
    expect(openTargets).toEqual(['http://127.0.0.1:48211/']);

    const payload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}')) as Record<string, unknown>;
    expect(payload).toMatchObject({
      reportSchemaVersion: 1,
      command: 'dashboard',
      format: 'html',
      outputPath,
      bytesWritten: expect.any(Number),
      served: true,
      url: 'http://127.0.0.1:48211/',
      host: '127.0.0.1',
      port: 48211,
      pid: process.pid,
      openRequested: true,
      openTarget: 'http://127.0.0.1:48211/',
    });
    expect(existsSync(outputPath)).toBe(true);
    expect(readFileSync(outputPath, 'utf8')).toContain('<!doctype html>');
    expectNoRuntimeArtifacts(runtimeDir);
  });

  it('rejects invalid serve shapes and invalid ports before collection or server startup', async () => {
    const runtimeDir = tempDir('byomem-dashboard-runtime-');
    const outputRoot = tempDir('byomem-dashboard-output-');
    const outputPath = resolve(outputRoot, 'dashboard.html');
    dirs.push(runtimeDir, outputRoot);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    mkdirSync(outputRoot, { recursive: true });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const createDashboardServer = vi.fn(async (options: DashboardServerOptions) => makeClosedServerHandle(options));

    const invalidCases = [
      { argv: ['dashboard', '--base-dir', runtimeDir, '--serve'], error: 'dashboard --serve requires --format html --output <path>' },
      { argv: ['dashboard', '--base-dir', runtimeDir, '--format', 'json', '--serve'], error: 'dashboard --serve requires --format html --output <path>' },
      { argv: ['dashboard', '--base-dir', runtimeDir, '--format', 'html', '--output', '-', '--serve'], error: 'dashboard does not support --output -' },
      { argv: ['dashboard', '--base-dir', runtimeDir, '--format', 'html', '--output', resolve(outputRoot, 'missing', 'dashboard.html'), '--serve'], error: 'Parent directory for --output must already exist' },
      { argv: ['dashboard', '--base-dir', runtimeDir, 'preview', '--serve'], error: 'Unexpected positional argument preview after dashboard' },
      { argv: ['dashboard', '--base-dir', runtimeDir, '--format', 'html', '--output', outputPath, '--serve', '--port'], error: 'Missing value for --port' },
      { argv: ['dashboard', '--base-dir', runtimeDir, '--format', 'html', '--output', outputPath, '--serve', '--port', '--open'], error: 'Missing value for --port' },
      { argv: ['dashboard', '--base-dir', runtimeDir, '--format', 'html', '--output', outputPath, '--serve', '--port', '1', '--port', '2'], error: '--port can only be provided once' },
      { argv: ['dashboard', '--base-dir', runtimeDir, '--format', 'html', '--output', outputPath, '--serve', '--port', '1.5'], error: '--port must be an integer between 0 and 65535' },
      { argv: ['dashboard', '--base-dir', runtimeDir, '--format', 'html', '--output', outputPath, '--serve', '--port', '-1'], error: '--port must be an integer between 0 and 65535' },
      { argv: ['dashboard', '--base-dir', runtimeDir, '--format', 'html', '--output', outputPath, '--serve', '--port', '65536'], error: '--port must be an integer between 0 and 65535' },
      { argv: ['dashboard', '--base-dir', runtimeDir, '--format', 'html', '--output', outputPath, '--host'], error: 'Missing value for --host' },
      { argv: ['dashboard', '--base-dir', runtimeDir, '--format', 'html', '--output', outputPath, '--host', '--serve'], error: 'Missing value for --host' },
      { argv: ['dashboard', '--base-dir', runtimeDir, '--format', 'html', '--output', outputPath, '--serve', '--host', '0.0.0.0', '--host', '127.0.0.1'], error: '--host can only be provided once' },
      { argv: ['dashboard', '--base-dir', runtimeDir, '--format', 'html', '--output', outputPath, '--serve', '--host', 'localhost'], error: '--host must be 127.0.0.1 or 0.0.0.0' },
      { argv: ['dashboard', '--base-dir', runtimeDir, '--format', 'html', '--output', outputPath, '--host', '0.0.0.0'], error: 'dashboard --host requires --serve' },
    ] as const;

    for (const testCase of invalidCases) {
      await main(testCase.argv, { createDashboardServer });
      expect(process.exitCode).toBe(1);
      expect(JSON.parse(String(errorSpy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
        error: testCase.error,
        command: 'dashboard',
      });
      expect(logSpy).not.toHaveBeenCalled();
      expect(createDashboardServer).not.toHaveBeenCalled();
      process.exitCode = undefined;
    }

    for (const port of [0, 1, 65535]) {
      await main(['dashboard', '--base-dir', runtimeDir, '--format', 'html', '--output', outputPath, '--serve', '--port', String(port)], {
        createDashboardServer,
      });
      expect(process.exitCode).toBeUndefined();
      expect(createDashboardServer.mock.calls.at(-1)?.[0]).toMatchObject({ port });
    }

    await main(['dashboard', '--base-dir', runtimeDir, '--format', 'html', '--output', outputPath, '--serve', '--host', '0.0.0.0', '--port', '48765'], {
      createDashboardServer,
    });
    expect(process.exitCode).toBeUndefined();
    expect(createDashboardServer.mock.calls.at(-1)?.[0]).toMatchObject({
      host: '0.0.0.0',
      port: 48765,
    });
    const hostPayload = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}')) as Record<string, unknown>;
    expect(hostPayload).toMatchObject({
      served: true,
      url: 'http://0.0.0.0:48765/',
      host: '0.0.0.0',
      port: 48765,
    });

    expectNoRuntimeArtifacts(runtimeDir);
  });

  it('serves only the generated HTML snapshot on allowed routes with conservative headers', async () => {
    const outputRoot = tempDir('byomem-dashboard-output-');
    const outputPath = resolve(outputRoot, 'custom-dashboard.html');
    dirs.push(outputRoot);
    mkdirSync(outputRoot, { recursive: true });
    const html = '<!doctype html><html><body>dashboard snapshot</body></html>';
    const handle = await createDashboardServer({ html, outputPath, host: '127.0.0.1', port: 0 });
    try {
      const allowedRoutes = ['/', '/index.html', `/${basename(outputPath)}`];
      for (const route of allowedRoutes) {
        const response = await readResponse(new URL(route, handle.url).toString());
        expect(response.status).toBe(200);
        expect(response.text).toBe(html);
        expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('content-security-policy')).toEqual(expect.stringMatching(/default-src 'none'/));
      }

      const missing = await readResponse(new URL('/does-not-exist', handle.url).toString());
      expect(missing.status).toBe(404);
      expect(missing.text).not.toBe(html);
    } finally {
      await handle.close();
    }
  });

  it('reports listen and open failures as structured JSON and closes the server on open failure', async () => {
    const runtimeDir = tempDir('byomem-dashboard-runtime-');
    const outputRoot = tempDir('byomem-dashboard-output-');
    const outputPath = resolve(outputRoot, 'dashboard.html');
    dirs.push(runtimeDir, outputRoot);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    mkdirSync(outputRoot, { recursive: true });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['dashboard', '--base-dir', runtimeDir, '--format', 'html', '--output', outputPath, '--serve'], {
      createDashboardServer: async () => {
        throw Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
      },
    });

    expect(process.exitCode).toBe(1);
    expect(logSpy).not.toHaveBeenCalled();
    expect(JSON.parse(String(errorSpy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      reportSchemaVersion: 1,
      error: 'listen EADDRINUSE',
      command: 'dashboard',
      format: 'html',
      outputPath,
      bytesWritten: expect.any(Number),
      served: false,
      server: expect.objectContaining({ code: 'EADDRINUSE' }),
    });

    process.exitCode = undefined;
    const directoryOutput = resolve(outputRoot, 'directory-output');
    mkdirSync(directoryOutput, { recursive: true });
    await main(['dashboard', '--base-dir', runtimeDir, '--format', 'html', '--output', directoryOutput, '--serve'], {
      createDashboardServer: async (options) => makeClosedServerHandle(options),
    });

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(String(errorSpy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      reportSchemaVersion: 1,
      command: 'dashboard',
      format: 'html',
      outputPath: directoryOutput,
      bytesWritten: 0,
      opened: false,
      write: expect.objectContaining({
        name: expect.any(String),
        message: expect.any(String),
      }),
    });

    process.exitCode = undefined;
    const closeSpy = vi.fn(async () => {});
    await main(['dashboard', '--base-dir', runtimeDir, '--format', 'html', '--output', outputPath, '--serve', '--open'], {
      createDashboardOpener: () => async () => {
        throw Object.assign(new Error('xdg-open exited with code 1'), { code: 'ENOENT', command: 'xdg-open', exitCode: 1, signal: null });
      },
      createDashboardServer: async (options) => makeClosedServerHandle({ ...options, port: 49222 }, closeSpy),
    });

    expect(process.exitCode).toBe(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(errorSpy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      reportSchemaVersion: 1,
      error: 'xdg-open exited with code 1',
      command: 'dashboard',
      format: 'html',
      outputPath,
      bytesWritten: expect.any(Number),
      opened: false,
      openTarget: 'http://127.0.0.1:49222/',
      url: 'http://127.0.0.1:49222/',
      openRequested: true,
      served: false,
      opener: expect.objectContaining({ code: 'ENOENT', command: 'xdg-open', exitCode: 1, signal: null }),
    });
    expectNoRuntimeArtifacts(runtimeDir);
  });

  it('closes an injected server on SIGINT and keeps diagnostics off stdout', async () => {
    const runtimeDir = tempDir('byomem-dashboard-runtime-');
    const outputRoot = tempDir('byomem-dashboard-output-');
    const outputPath = resolve(outputRoot, 'dashboard.html');
    dirs.push(runtimeDir, outputRoot);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    mkdirSync(outputRoot, { recursive: true });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let resolveClosed: (() => void) | undefined;
    const closeSpy = vi.fn(async () => {
      resolveClosed?.();
    });
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });

    const serve = main(['dashboard', '--base-dir', runtimeDir, '--format', 'html', '--output', outputPath, '--serve'], {
      createDashboardServer: async (options) => ({
        ...makeClosedServerHandle({ ...options, port: 49333 }, closeSpy),
        waitUntilClosed: () => closed,
      }),
    });

    await vi.waitFor(() => expect(logSpy).toHaveBeenCalled());
    process.emit('SIGINT', 'SIGINT');
    await serve;

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy.mock.calls).toHaveLength(1);
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0] ?? '{}'))).toMatchObject({
      reportSchemaVersion: 1,
      served: true,
      url: 'http://127.0.0.1:49333/',
    });
    expectNoRuntimeArtifacts(runtimeDir);
  });
});
