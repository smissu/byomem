import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DashboardModel } from '../src/dashboard.js';
import { createDashboardServer, type DashboardRefreshProvider, type DashboardServerOptions } from '../src/dashboard-server.js';

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

function model(generatedAt: string): DashboardModel {
  return {
    schemaVersion: 1,
    command: 'dashboard',
    runtimeVersion: '0.0.0-test',
    generatedAt,
    overallStatus: 'pass',
    identityMeta: { runtimeVersion: '0.0.0-test', projectBaseDir: '/repo/project', runtimeBaseDir: '/repo/runtime', generatedAt, overallStatus: 'pass' },
    projectBaseDir: '/repo/project',
    runtimeBaseDir: '/repo/runtime',
    paths: { projectBaseDir: '/repo/project', runtimeBaseDir: '/repo/runtime' },
    degradedComponents: [],
    kpiCards: [],
    capabilityBanners: [],
    profileSummary: {
      source: 'not-collected',
      collectedAt: generatedAt,
      projectBaseDir: '/repo/project',
      runtimeBaseDir: '/repo/runtime',
      fileSearch: { state: 'not-collected', evidenceTier: 'not-collected', summary: 'not collected', warnings: [] },
      graph: { state: 'not-collected', evidenceTier: 'not-collected', summary: 'not collected', warnings: [] },
      embedding: { state: 'not-collected', evidenceTier: 'not-collected', summary: 'not collected', model: null, dimensions: null, warnings: [] },
    },
    runtimeProcesses: {
      source: 'runtime-state',
      evidenceTier: 'stat-only',
      evidenceConfidence: 'definite',
      status: 'ready',
      summary: 'safe process panel',
      counts: { total: 1, active: 1, stale: 0, malformed: 0 },
      roles: ['memory'],
      duplicateActiveRoles: [],
      records: [],
      malformed: [],
      warnings: [],
    },
    activeContext: { selectedContextId: 'alpha', options: [], warnings: [] },
    selectedContext: {
      contextId: 'alpha',
      status: 'ready',
      label: 'Alpha',
      projectKey: 'alpha',
      projectDisplayName: 'Alpha',
      projectBaseDir: '/repo/project',
      sessionKey: 'session-a',
      sessionLabel: 'Session A',
      roles: ['memory'],
      processCounts: { total: 1, active: 1, stale: 0, malformed: 0 },
      startedAt: generatedAt,
      lastHeartbeatAt: generatedAt,
      evidenceConfidence: 'definite',
      warnings: [],
      summary: 'safe alpha summary',
    },
    firstRunGuidance: [],
    sectionSummaries: [],
    commandCards: [],
    statusComponents: [],
    doctorChecks: [],
    warnings: [],
    suggestedActions: [],
  };
}

describe('sprint 101 read-only refresh boundary', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('keeps dashboard refresh source away from mutation, process, transport, scan, graph, and config-write paths', () => {
    const dashboardSource = readFileSync(new URL('../src/dashboard.ts', import.meta.url), 'utf8');
    const serverSource = readFileSync(new URL('../src/dashboard-server.ts', import.meta.url), 'utf8');
    const cliSource = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    const relevantSource = [dashboardSource, serverSource, cliSource].join('\n');
    const refreshSource = [dashboardSource, serverSource].join('\n');

    const disallowedPatterns = [
      /from ['"][^'"]*process-cleanup\.js['"]/,
      /from ['"][^'"]*runtime-state-lifecycle\.js['"]/,
      /from ['"][^'"]*remove\.js['"]/,
      /from ['"][^'"]*codex-connect\.js['"]/,
      /from ['"][^'"]*file-search-active-poller\.js['"]/,
      /from ['"][^'"]*file-search-semantic-refresh\.js['"]/,
      /from ['"][^'"]*file-search-index\.js['"]/,
      /from ['"][^'"]*file-search-project-registry\.js['"]/,
      /from ['"][^'"]*graph-db\.js['"]/,
      /from ['"][^'"]*store\.js['"]/,
      /from ['"][^'"]*child_process(?:['"]|$)/,
      /StdioServerTransport/,
      /process\.kill/,
      /\bwriteRuntimeState\b/,
    ];

    for (const pattern of disallowedPatterns) {
      expect(relevantSource).not.toMatch(pattern);
    }
    for (const pattern of [/\bscanRefresh\b/, /\bgraphUpdate\b/]) {
      expect(refreshSource).not.toMatch(pattern);
    }
  });

  it('does not create runtime artifacts or expose raw unsafe fields from refreshed JSON and HTML', async () => {
    const outputRoot = tempDir('byomem-s101-boundary-');
    const missingRuntime = join(outputRoot, 'missing-runtime');
    dirs.push(outputRoot);
    mkdirSync(outputRoot, { recursive: true });
    const refreshProvider = vi.fn<DashboardRefreshProvider>(async () => {
      const unsafeModel = model('2026-06-04T10:00:00.000Z');
      unsafeModel.runtimeProcesses.records = [{
        role: 'memory',
        serverName: 'byomem-mcp-memory',
        pid: 123,
        ppid: 122,
        entrypoint: 'mcp-memory',
        runtimeVersion: '0.0.0-test',
        startedAt: '2026-06-04T10:00:00.000Z',
        lastHeartbeatAt: '2026-06-04T10:00:00.000Z',
        state: 'active',
        staleReason: null,
        path: '/tmp/SECRET_NESTED_RUNTIME_STATE_RECORD',
        identity: null,
      }];
      unsafeModel.runtimeProcesses.duplicateActiveRoles = [{
        role: 'memory',
        count: 1,
        records: [{
          pid: 123,
          serverName: 'byomem-mcp-memory',
          entrypoint: 'mcp-memory',
          path: '/tmp/SECRET_DUPLICATE_RUNTIME_STATE_RECORD',
        }],
      }];
      return {
        generatedAt: '2026-06-04T10:00:00.000Z',
        refreshId: 'refresh-safe',
        source: 'explicit-injection',
        selectedContextId: 'alpha',
        contexts: [{
          contextId: 'alpha',
          label: 'Alpha',
          summary: 'safe summary',
          source: 'explicit-injection',
          argv: ['node', '--token=SECRET_ARGV'],
          cwd: '/tmp/SECRET_CWD',
          env: { TOKEN: 'SECRET_ENV' },
          hostname: 'SECRET_HOSTNAME',
          transcriptId: 'SECRET_TRANSCRIPT',
          command: 'node secret-command.js',
          configPath: '/tmp/SECRET_CONFIG',
          path: '/tmp/SECRET_RUNTIME_STATE_RECORD',
        }],
        selectedDashboardModel: unsafeModel,
        selectedDashboardHtml: '<!doctype html><html><body>safe html without secrets <code>/tmp/runtime-state/processes/SECRET_HTML_RUNTIME_STATE_RECORD.json</code></body></html>',
        warnings: ['safe warning'],
        errors: [],
      };
    });
    const handle = await createDashboardServer({
      html: '<!doctype html><html><body>startup</body></html>',
      outputPath: resolve(outputRoot, 'dashboard.html'),
      host: '127.0.0.1',
      port: 0,
      interactive: true,
      refreshProvider,
    } as DashboardServerOptions);

    try {
      const jsonResponse = await fetch(new URL('/api/dashboard.refresh?contextId=alpha', handle.url));
      expect(jsonResponse.status).toBe(200);
      const json = await jsonResponse.text();
      const htmlResponse = await fetch(new URL('/api/dashboard.html?contextId=alpha', handle.url));
      expect(htmlResponse.status).toBe(200);
      const html = await htmlResponse.text();
      const combined = `${json}\n${html}`;

      for (const unsafe of [
        'SECRET_ARGV',
        'SECRET_CWD',
        'SECRET_ENV',
        'SECRET_HOSTNAME',
        'SECRET_TRANSCRIPT',
        'secret-command.js',
        'SECRET_CONFIG',
        'SECRET_RUNTIME_STATE_RECORD',
        'SECRET_NESTED_RUNTIME_STATE_RECORD',
        'SECRET_DUPLICATE_RUNTIME_STATE_RECORD',
        'SECRET_HTML_RUNTIME_STATE_RECORD',
      ]) {
        expect(combined).not.toContain(unsafe);
      }
      expect(refreshProvider).toHaveBeenCalledTimes(2);
      expectNoRuntimeArtifacts(missingRuntime);
    } finally {
      await handle.close();
    }
  });
});
