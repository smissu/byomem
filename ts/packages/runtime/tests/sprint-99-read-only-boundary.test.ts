import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { buildByomemDashboardModel, renderByomemDashboardHtml } from '../src/dashboard.js';
import type { DoctorReport } from '../src/doctor.js';
import type { StatusReport } from '../src/status-report.js';
import { BYOMEM_RUNTIME_VERSION } from '../src/version.js';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function artifact(path: string) {
  return { path, exists: false, sizeBytes: null, mtimeMs: null, mtime: null };
}

function minimalStatusReport(runtimeBaseDir: string): StatusReport {
  return {
    version: BYOMEM_RUNTIME_VERSION,
    runtimeVersion: BYOMEM_RUNTIME_VERSION,
    generatedAt: '2026-06-02T00:00:00.000Z',
    projectBaseDir: runtimeBaseDir,
    runtimeBaseDir,
    projectKey: 'project',
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
      count: 1,
      roles: ['memory'],
      duplicateActiveRoles: [],
      staleCount: 0,
      malformedCount: 0,
      warnings: [],
    },
  };
}

function minimalDoctorReport(runtimeBaseDir: string): DoctorReport {
  return {
    command: 'doctor',
    version: BYOMEM_RUNTIME_VERSION,
    runtimeVersion: BYOMEM_RUNTIME_VERSION,
    generatedAt: '2026-06-02T00:00:00.000Z',
    projectBaseDir: runtimeBaseDir,
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
              pid: 123,
              ppid: 1,
              argv: ['node', '--token=SECRET_SHOULD_NOT_RENDER'],
              cwd: '/tmp/SECRET_CWD_SHOULD_NOT_RENDER',
              entrypoint: 'mcp-memory',
              runtimeVersion: BYOMEM_RUNTIME_VERSION,
              startedAt: '2026-06-02T00:00:01.000Z',
              lastHeartbeatAt: '2026-06-02T00:10:01.000Z',
              state: 'active',
              staleReason: null,
              path: join(runtimeBaseDir, 'runtime-state/processes/memory-123.json'),
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

function expectNoRuntimeArtifacts(runtimeDir: string): void {
  expect(existsSync(join(runtimeDir, 'runtime-state'))).toBe(false);
  expect(existsSync(join(runtimeDir, 'native-store.json'))).toBe(false);
  expect(existsSync(join(runtimeDir, 'byomem-index.sqlite'))).toBe(false);
  expect(existsSync(join(runtimeDir, 'byomem-file-search.sqlite'))).toBe(false);
  expect(existsSync(join(runtimeDir, 'byomem-graph.sqlite'))).toBe(false);
}

describe('sprint 99 runtime process dashboard read-only boundary', () => {
  const dirs: string[] = [];
  const originalRuntimeBase = process.env.BYOMEM_RUNTIME_BASE_DIR;

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    if (originalRuntimeBase === undefined) delete process.env.BYOMEM_RUNTIME_BASE_DIR;
    else process.env.BYOMEM_RUNTIME_BASE_DIR = originalRuntimeBase;
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('omits raw argv cwd and environment-like values from dashboard JSON and HTML', () => {
    const runtimeDir = tempDir('byomem-s99-runtime-');
    dirs.push(runtimeDir);

    const model = buildByomemDashboardModel({
      statusReport: minimalStatusReport(runtimeDir),
      doctorReport: minimalDoctorReport(runtimeDir),
      generatedAt: '2026-06-02T00:00:00.000Z',
    });
    const json = JSON.stringify(model);
    const html = renderByomemDashboardHtml(model);

    expect(json).not.toContain('SECRET_SHOULD_NOT_RENDER');
    expect(json).not.toContain('SECRET_CWD_SHOULD_NOT_RENDER');
    expect(html).not.toContain('SECRET_SHOULD_NOT_RENDER');
    expect(html).not.toContain('SECRET_CWD_SHOULD_NOT_RENDER');
  });

  it('does not create runtime-state directories or artifacts while generating dashboard output', async () => {
    const runtimeDir = tempDir('byomem-s99-runtime-');
    dirs.push(runtimeDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['dashboard', '--runtime-base-dir', runtimeDir]);

    expect(process.exitCode).toBeUndefined();
    expect(JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'))).toHaveProperty('runtimeProcesses');
    expectNoRuntimeArtifacts(runtimeDir);
  });

  it('keeps dashboard code away from mutation and live process inspection imports', () => {
    const dashboardSource = readFileSync(new URL('../src/dashboard.ts', import.meta.url), 'utf8');

    expect(dashboardSource).not.toMatch(/from ['"].*process-cleanup/);
    expect(dashboardSource).not.toMatch(/from ['"].*runtime-state/);
    expect(dashboardSource).not.toMatch(/registerRuntimeProcess|unregisterRuntimeProcess/);
    expect(dashboardSource).not.toMatch(/child_process|process\.kill/);
  });
});
