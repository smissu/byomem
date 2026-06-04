import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { createDashboardServer } from '../src/dashboard-server.js';
import { buildByomemDashboardModel, renderByomemDashboardHtml } from '../src/dashboard.js';
import type { DoctorReport } from '../src/doctor.js';
import type { StatusReport } from '../src/status-report.js';

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

function artifact(path: string) {
  return { path, exists: false, sizeBytes: null, mtimeMs: null, mtime: null };
}

function minimalStatusReport(projectBaseDir: string, runtimeBaseDir: string): StatusReport {
  return {
    version: '0.0.0-test',
    runtimeVersion: '0.0.0-test',
    generatedAt: '2026-06-04T00:00:00.000Z',
    projectBaseDir,
    runtimeBaseDir,
    projectKey: 'project-key',
    paths: {
      memory: { json: join(runtimeBaseDir, 'native-store.json'), sqlite: join(runtimeBaseDir, 'byomem-index.sqlite') },
      fileSearch: { sqlite: join(runtimeBaseDir, 'byomem-file-search.sqlite') },
      graph: { sqlite: join(runtimeBaseDir, 'byomem-graph.sqlite') },
    },
    artifacts: {
      memory: { status: 'missing', warnings: [], json: artifact(join(runtimeBaseDir, 'native-store.json')), sqlite: artifact(join(runtimeBaseDir, 'byomem-index.sqlite')) },
      fileSearch: { status: 'missing', warnings: [], sqlite: artifact(join(runtimeBaseDir, 'byomem-file-search.sqlite')) },
      graph: { status: 'missing', warnings: [], sqlite: artifact(join(runtimeBaseDir, 'byomem-graph.sqlite')) },
    },
    warnings: [],
    degradedComponents: [],
    mcpProcesses: {
      source: 'runtime-state',
      count: 0,
      roles: [],
      duplicateActiveRoles: [],
      staleCount: 0,
      malformedCount: 0,
      warnings: [],
    },
  };
}

function minimalDoctorReport(projectBaseDir: string, runtimeBaseDir: string): DoctorReport {
  return {
    command: 'doctor',
    version: '0.0.0-test',
    runtimeVersion: '0.0.0-test',
    generatedAt: '2026-06-04T00:00:00.000Z',
    projectBaseDir,
    runtimeBaseDir,
    overallStatus: 'pass',
    checks: [
      {
        id: 'runtime-state.process-liveness',
        component: 'runtime-state',
        status: 'pass',
        severity: 'info',
        title: 'Runtime process records have consistent liveness evidence',
        evidenceConfidence: 'definite',
        evidence: {
          counts: { total: 1, active: 1, stale: 0, malformed: 0 },
          records: [
            {
              role: 'memory',
              serverName: 'byomem-mcp-memory',
              pid: 101,
              ppid: 1,
              argv: ['node', '--token=SECRET_TOKEN_SHOULD_NOT_RENDER'],
              cwd: '/tmp/SECRET_CWD_SHOULD_NOT_RENDER',
              entrypoint: 'mcp-memory',
              runtimeVersion: '0.0.0-test',
              startedAt: '2026-06-04T00:00:01.000Z',
              lastHeartbeatAt: '2026-06-04T00:10:01.000Z',
              state: 'active',
              staleReason: null,
              path: join(runtimeBaseDir, 'runtime-state/processes/memory-101.json'),
            },
          ],
          malformed: [],
        },
        warnings: [],
        suggestedActions: [],
        skippedReason: null,
      },
    ],
    warnings: [],
    suggestedActions: [],
  };
}

describe('sprint 100 read-only boundary', () => {
  const dirs: string[] = [];
  const originalRuntimeBase = process.env.BYOMEM_RUNTIME_BASE_DIR;

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    if (originalRuntimeBase === undefined) delete process.env.BYOMEM_RUNTIME_BASE_DIR;
    else process.env.BYOMEM_RUNTIME_BASE_DIR = originalRuntimeBase;
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('keeps dashboard and switcher source files away from cleanup, transport, registry, and config-write imports', () => {
    const cliSource = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const dashboardSource = readFileSync(new URL('../src/dashboard.ts', import.meta.url), 'utf8');
    const serverSource = readFileSync(new URL('../src/dashboard-server.ts', import.meta.url), 'utf8');

    const disallowedPatterns = [
      /from ['"][^'"]*process-cleanup\.js['"]/,
      /from ['"][^'"]*remove\.js['"]/,
      /from ['"][^'"]*codex-connect\.js['"]/,
      /from ['"][^'"]*file-search-project-registry\.js['"]/,
      /from ['"][^'"]*file-search-active-poller\.js['"]/,
      /from ['"][^'"]*file-search-semantic-refresh\.js['"]/,
      /from ['"][^'"]*file-search-index\.js['"]/,
      /from ['"][^'"]*graph-db\.js['"]/,
      /from ['"][^'"]*store\.js['"]/,
      /from ['"][^'"]*child_process(?:['"]|$)/,
      /StdioServerTransport/,
      /runtime-state-lifecycle/,
      /process\.kill/,
    ];

    for (const source of [dashboardSource, serverSource, cliSource]) {
      for (const pattern of disallowedPatterns) {
        expect(source).not.toMatch(pattern);
      }
    }
  });

  it('leaves empty project and runtime directories untouched during static dashboard generation', async () => {
    const workspace = tempDir('byomem-s100-static-');
    const projectDir = join(workspace, 'project');
    const runtimeDir = join(workspace, 'runtime');
    const outputRoot = join(workspace, 'output');
    const outputPath = join(outputRoot, 'dashboard.html');
    dirs.push(workspace);
    mkdirSync(outputRoot, { recursive: true });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(existsSync(projectDir)).toBe(false);
    expect(existsSync(runtimeDir)).toBe(false);

    await main(['dashboard', '--base-dir', projectDir, '--runtime-base-dir', runtimeDir, '--format', 'html', '--output', outputPath]);

    expect(process.exitCode).toBeUndefined();
    expect(logSpy).toHaveBeenCalled();
    expect(readFileSync(outputPath, 'utf8')).toContain('<!doctype html>');
    expect(existsSync(projectDir)).toBe(false);
    expect(existsSync(runtimeDir)).toBe(false);
    expectNoRuntimeArtifacts(projectDir);
    expectNoRuntimeArtifacts(runtimeDir);
  });

  it('passes no-create canaries through the interactive dashboard server routes for missing project and runtime directories', async () => {
    const workspace = tempDir('byomem-s100-interactive-');
    const projectDir = join(workspace, 'project');
    const runtimeDir = join(workspace, 'runtime');
    const outputRoot = join(workspace, 'output');
    const outputPath = join(outputRoot, 'dashboard.html');
    dirs.push(workspace);
    mkdirSync(outputRoot, { recursive: true });
    const handle = await createDashboardServer({
      html: '<!doctype html><html><body>dashboard</body></html>',
      outputPath,
      host: '127.0.0.1',
      port: 0,
    });

    try {
      expect(existsSync(projectDir)).toBe(false);
      expect(existsSync(runtimeDir)).toBe(false);

      const contextsResponse = await fetch(new URL('/api/contexts', handle.url));
      expect(contextsResponse.status).toBe(200);
      expect(contextsResponse.headers.get('content-type')).toContain('application/json');
      expect(contextsResponse.headers.get('cache-control')).toBe('no-store');
      const contexts = await contextsResponse.json() as { contexts?: unknown };
      expect(contexts).toHaveProperty('contexts');

      const dashboardResponse = await fetch(new URL('/api/dashboard.json?contextId=missing-context', handle.url));
      expect(dashboardResponse.status).toBe(200);
      expect(dashboardResponse.headers.get('content-type')).toContain('application/json');
      expect(dashboardResponse.headers.get('cache-control')).toBe('no-store');
      const dashboard = await dashboardResponse.json() as { contextId?: string };
      expect(dashboard).toMatchObject({ contextId: 'missing-context' });

      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
        const response = await fetch(new URL('/api/contexts', handle.url), { method });
        expect(response.status).toBe(405);
      }

      expect(existsSync(projectDir)).toBe(false);
      expect(existsSync(runtimeDir)).toBe(false);
      expectNoRuntimeArtifacts(projectDir);
      expectNoRuntimeArtifacts(runtimeDir);
    } finally {
      await handle.close();
    }
  });

  it('fails mutation-looking dashboard flags before any dashboard collection runs', async () => {
    const workspace = tempDir('byomem-s100-flags-');
    const runtimeDir = join(workspace, 'runtime');
    dirs.push(workspace);
    mkdirSync(runtimeDir, { recursive: true });
    const statusModule = await import('../src/status-report.js');
    const doctorModule = await import('../src/doctor.js');
    const profileModule = await import('../src/dashboard-profile.js');
    const statusSpy = vi.spyOn(statusModule, 'buildByomemStatusReport');
    const doctorSpy = vi.spyOn(doctorModule, 'buildByomemDoctorReport');
    const profileSpy = vi.spyOn(profileModule, 'collectDashboardProfileSummary');
    const cases = [
      ['--apply'],
      ['--delete-data'],
      ['--kill-processes'],
      ['--force'],
      ['--watch'],
      ['--watch-interval', '1'],
      ['--refresh'],
      ['--scan'],
      ['--graph-update'],
      ['--cleanup'],
      ['--stop'],
    ] as const;

    for (const flags of cases) {
      await main(['dashboard', '--base-dir', runtimeDir, ...flags]);

      expect(process.exitCode).toBe(1);
      expect(statusSpy).not.toHaveBeenCalled();
      expect(doctorSpy).not.toHaveBeenCalled();
      expect(profileSpy).not.toHaveBeenCalled();
      expectNoRuntimeArtifacts(runtimeDir);
      process.exitCode = undefined;
      statusSpy.mockClear();
      doctorSpy.mockClear();
      profileSpy.mockClear();
    }
  });

  it('omits secret-bearing injected evidence from dashboard JSON and HTML', () => {
    const projectDir = '/repo/project';
    const runtimeDir = '/repo/runtime';
    const model = buildByomemDashboardModel({
      statusReport: minimalStatusReport(projectDir, runtimeDir),
      doctorReport: minimalDoctorReport(projectDir, runtimeDir),
      generatedAt: '2026-06-04T00:00:00.000Z',
    });
    const json = JSON.stringify(model, null, 2);
    const html = renderByomemDashboardHtml(model);

    expect(json).not.toContain('SECRET_TOKEN_SHOULD_NOT_RENDER');
    expect(json).not.toContain('SECRET_CWD_SHOULD_NOT_RENDER');
    expect(html).not.toContain('SECRET_TOKEN_SHOULD_NOT_RENDER');
    expect(html).not.toContain('SECRET_CWD_SHOULD_NOT_RENDER');
    expect(html).not.toContain('secret-bearing evidence should never surface');
  });
});
