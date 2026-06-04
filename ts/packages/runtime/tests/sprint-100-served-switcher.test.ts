import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { main } from '../src/cli.js';
import { createDashboardServer, type DashboardServerHandle, type DashboardServerOptions } from '../src/dashboard-server.js';

type InteractiveContextEvidence = {
  contextId: string;
  label: string;
  summary: string;
  source: 'startup-cache' | 'explicit-injection';
};

type InteractiveDashboardServerOptions = DashboardServerOptions & {
  interactive: true;
  contexts: InteractiveContextEvidence[];
  evidenceSource: 'startup-cache' | 'explicit-injection';
};

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function expectNoRuntimeArtifacts(baseDir: string): void {
  expect(existsSync(join(baseDir, 'native-store.json'))).toBe(false);
  expect(existsSync(join(baseDir, 'byomem-index.sqlite'))).toBe(false);
  expect(existsSync(join(baseDir, 'byomem-file-search.sqlite'))).toBe(false);
  expect(existsSync(join(baseDir, 'byomem-graph.sqlite'))).toBe(false);
  expect(existsSync(join(baseDir, 'queue.json'))).toBe(false);
  expect(existsSync(join(baseDir, 'worker.json'))).toBe(false);
  expect(existsSync(join(baseDir, 'runtime-state'))).toBe(false);
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

async function readResponse(url: string, init?: RequestInit): Promise<{ status: number; headers: Headers; text: string }> {
  const response = await fetch(url, init);
  return {
    status: response.status,
    headers: response.headers,
    text: await response.text(),
  };
}

describe('sprint 100 served switcher', () => {
  const dirs: string[] = [];
  const originalRuntimeBase = process.env.BYOMEM_RUNTIME_BASE_DIR;

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    if (originalRuntimeBase === undefined) delete process.env.BYOMEM_RUNTIME_BASE_DIR;
    else process.env.BYOMEM_RUNTIME_BASE_DIR = originalRuntimeBase;
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('keeps non-interactive serve on the static snapshot routes and leaves /api/* unavailable', async () => {
    const outputRoot = tempDir('byomem-s100-output-');
    const outputPath = resolve(outputRoot, 'dashboard.html');
    dirs.push(outputRoot);
    mkdirSync(dirname(outputPath), { recursive: true });

    const html = '<!doctype html><html><body>snapshot</body></html>';
    const handle = await createDashboardServer({ html, outputPath, host: '127.0.0.1', port: 0 });
    try {
      for (const route of ['/', '/index.html', `/${basename(outputPath)}`]) {
        const response = await readResponse(new URL(route, handle.url).toString());
        expect(response.status).toBe(200);
        expect(response.text).toBe(html);
        expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
      }

      for (const apiRoute of ['/api/contexts', '/api/dashboard.json?contextId=alpha']) {
        const response = await readResponse(new URL(apiRoute, handle.url).toString());
        expect(response.status).toBe(404);
        expect(response.headers.get('content-type')).not.toBe('application/json');
      }
    } finally {
      await handle.close();
    }
  });

  it('exposes interactive JSON endpoints from startup-cached evidence and rejects unknown context ids', async () => {
    const outputRoot = tempDir('byomem-s100-output-');
    const outputPath = resolve(outputRoot, 'interactive-dashboard.html');
    dirs.push(outputRoot);
    mkdirSync(outputRoot, { recursive: true });

    const interactiveOptions: InteractiveDashboardServerOptions = {
      html: '<!doctype html><html><body>interactive shell</body></html>',
      outputPath,
      host: '127.0.0.1',
      port: 0,
      interactive: true,
      evidenceSource: 'startup-cache',
      contexts: [
        {
          contextId: 'alpha',
          label: 'Alpha session',
          summary: 'Startup-cached read-only evidence for alpha.',
          source: 'startup-cache',
        },
        {
          contextId: 'beta',
          label: 'Beta project',
          summary: 'Startup-cached read-only evidence for beta.',
          source: 'startup-cache',
        },
      ],
    };

    const handle = await createDashboardServer(interactiveOptions as unknown as DashboardServerOptions);
    try {
      const shellResponse = await readResponse(new URL('/', handle.url).toString());
      expect(shellResponse.status).toBe(200);
      expect(shellResponse.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(shellResponse.headers.get('content-security-policy')).toContain("connect-src 'self'");
      expect(shellResponse.headers.get('content-security-policy')).toContain("script-src 'unsafe-inline'");
      expect(shellResponse.text).toContain('rel="icon"');
      expect(shellResponse.text).toContain('href="data:image/svg+xml');
      expect(shellResponse.text).toContain('id="byomem-context-select"');
      expect(shellResponse.text).toContain('Alpha session');
      expect(shellResponse.text).toContain('Beta project');
      expect(shellResponse.text).toContain('/api/contexts');
      expect(shellResponse.text).toContain('/api/dashboard.json');

      const contextsResponse = await readResponse(new URL('/api/contexts', handle.url).toString());
      expect(contextsResponse.status).toBe(200);
      expect(contextsResponse.headers.get('content-type')).toBe('application/json');
      expect(contextsResponse.headers.get('cache-control')).toBe('no-store');
      expect(contextsResponse.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(JSON.parse(contextsResponse.text)).toMatchObject({
        contexts: expect.arrayContaining([
          expect.objectContaining({ contextId: 'alpha', source: 'startup-cache' }),
          expect.objectContaining({ contextId: 'beta', source: 'startup-cache' }),
        ]),
      });

      const dashboardResponse = await readResponse(new URL('/api/dashboard.json?contextId=alpha', handle.url).toString());
      expect(dashboardResponse.status).toBe(200);
      expect(dashboardResponse.headers.get('content-type')).toBe('application/json');
      expect(dashboardResponse.headers.get('cache-control')).toBe('no-store');
      expect(JSON.parse(dashboardResponse.text)).toMatchObject({
        contextId: 'alpha',
        source: 'startup-cache',
      });

      const invalidContextResponse = await readResponse(new URL('/api/dashboard.json?contextId=../../etc/passwd', handle.url).toString());
      expect(invalidContextResponse.status).toBe(400);
      expect(invalidContextResponse.headers.get('content-type')).toBe('application/json');
      expect(JSON.parse(invalidContextResponse.text)).toMatchObject({
        error: expect.stringMatching(/context/i),
        contextId: '../../etc/passwd',
      });

      expectNoRuntimeArtifacts(outputRoot);
    } finally {
      await handle.close();
    }
  });

  it('fails closed on mutation methods in interactive mode without falling through to collection or writes', async () => {
    const outputRoot = tempDir('byomem-s100-output-');
    const outputPath = resolve(outputRoot, 'interactive-dashboard.html');
    dirs.push(outputRoot);
    mkdirSync(outputRoot, { recursive: true });

    const handle = await createDashboardServer({
      html: '<!doctype html><html><body>interactive shell</body></html>',
      outputPath,
      host: '127.0.0.1',
      port: 0,
      interactive: true,
      contexts: [
        {
          contextId: 'alpha',
          label: 'Alpha session',
          summary: 'Startup-cached read-only evidence for alpha.',
          source: 'startup-cache',
        },
      ],
      evidenceSource: 'startup-cache',
    } as unknown as DashboardServerOptions);

    try {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
        const response = await readResponse(new URL('/api/dashboard.json?contextId=alpha', handle.url).toString(), { method });
        expect(response.status).toBe(405);
        expect(response.headers.get('content-type')).toBe('application/json');
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(JSON.parse(response.text)).toMatchObject({
          error: expect.stringMatching(/method|mutation|read-only/i),
          method,
        });
      }
    } finally {
      await handle.close();
    }
  });

  it('--interactive requires --serve --format html --output <path> and should reach the server with cached evidence when valid', async () => {
    const runtimeDir = tempDir('byomem-s100-runtime-');
    const outputRoot = tempDir('byomem-s100-output-');
    const outputPath = resolve(outputRoot, 'dashboard.html');
    dirs.push(runtimeDir, outputRoot);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    mkdirSync(outputRoot, { recursive: true });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const serverOptions: InteractiveDashboardServerOptions[] = [];
    const createDashboardServer = vi.fn(async (options: DashboardServerOptions) => {
      serverOptions.push(options as InteractiveDashboardServerOptions);
      return makeClosedServerHandle(options);
    });

    await main(
      ['dashboard', '--base-dir', runtimeDir, '--format', 'html', '--output', outputPath, '--serve', '--interactive'],
      { createDashboardServer },
    );

    expect(process.exitCode).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();
    expect(createDashboardServer).toHaveBeenCalledTimes(1);
    expect(serverOptions[0]).toMatchObject({
      interactive: true,
      evidenceSource: 'startup-cache',
      contexts: expect.arrayContaining([
        expect.objectContaining({ contextId: 'alpha', source: 'startup-cache' }),
      ]),
    });
    expectNoRuntimeArtifacts(runtimeDir);
  });
});
