import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DashboardModel } from '../src/dashboard.js';
import {
  createDashboardServer,
  type DashboardRefreshProvider,
  type DashboardServerOptions,
} from '../src/dashboard-server.js';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function readResponse(url: string, init?: RequestInit): Promise<{ status: number; headers: Headers; text: string }> {
  const response = await fetch(url, init);
  return { status: response.status, headers: response.headers, text: await response.text() };
}

function model(contextId: string, generatedAt: string): DashboardModel {
  return {
    schemaVersion: 1,
    command: 'dashboard',
    runtimeVersion: '0.0.0-test',
    generatedAt,
    overallStatus: 'pass',
    identityMeta: { runtimeVersion: '0.0.0-test', projectBaseDir: '/repo', runtimeBaseDir: '/runtime', generatedAt, overallStatus: 'pass' },
    projectBaseDir: '/repo',
    runtimeBaseDir: '/runtime',
    paths: { projectBaseDir: '/repo', runtimeBaseDir: '/runtime' },
    degradedComponents: [],
    kpiCards: [],
    capabilityBanners: [],
    profileSummary: {
      source: 'not-collected',
      collectedAt: generatedAt,
      projectBaseDir: '/repo',
      runtimeBaseDir: '/runtime',
      fileSearch: { state: 'not-collected', evidenceTier: 'not-collected', summary: 'not collected', warnings: [] },
      graph: { state: 'not-collected', evidenceTier: 'not-collected', summary: 'not collected', warnings: [] },
      embedding: { state: 'not-collected', evidenceTier: 'not-collected', summary: 'not collected', model: null, dimensions: null, warnings: [] },
    },
    runtimeProcesses: {
      source: 'runtime-state',
      evidenceTier: 'stat-only',
      evidenceConfidence: 'definite',
      status: 'ready',
      summary: 'runtime process panel',
      counts: { total: 1, active: 1, stale: 0, malformed: 0 },
      roles: ['memory'],
      duplicateActiveRoles: [],
      records: [],
      malformed: [],
      warnings: [],
    },
    activeContext: {
      selectedContextId: contextId,
      options: [],
      warnings: [],
    },
    selectedContext: {
      contextId,
      status: 'ready',
      label: `${contextId} label`,
      projectKey: contextId,
      projectDisplayName: `${contextId} project`,
      projectBaseDir: `/repo/${contextId}`,
      sessionKey: null,
      sessionLabel: null,
      roles: ['memory'],
      processCounts: { total: 1, active: 1, stale: 0, malformed: 0 },
      startedAt: generatedAt,
      lastHeartbeatAt: generatedAt,
      evidenceConfidence: 'definite',
      warnings: [],
      summary: `${contextId} selected summary`,
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

function provider(): DashboardRefreshProvider {
  let call = 0;
  return vi.fn(async ({ selectedContextId }) => {
    call += 1;
    const contextId = selectedContextId || 'alpha';
    const generatedAt = `2026-06-04T10:00:0${call}.000Z`;
    return {
      generatedAt,
      refreshId: `refresh-${call}`,
      source: 'explicit-injection',
      selectedContextId: contextId,
      contexts: [
        { contextId: 'alpha', label: `Alpha ${call}`, summary: `Alpha summary ${call}`, source: 'explicit-injection' },
        { contextId: 'beta', label: `Beta ${call}`, summary: `Beta summary ${call}`, source: 'explicit-injection' },
      ],
      selectedDashboardModel: model(contextId, generatedAt),
      selectedDashboardHtml: `<!doctype html><html><body>${contextId} html ${call}</body></html>`,
      warnings: [`warning ${call}`],
      errors: [],
    };
  });
}

describe('sprint 101 served refresh API', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('keeps non-interactive serve static and leaves /api/* unavailable', async () => {
    const outputRoot = tempDir('byomem-s101-api-');
    dirs.push(outputRoot);
    mkdirSync(outputRoot, { recursive: true });
    const refreshProvider = provider();
    const handle = await createDashboardServer({
      html: '<!doctype html><html><body>static</body></html>',
      outputPath: resolve(outputRoot, 'dashboard.html'),
      host: '127.0.0.1',
      port: 0,
      refreshProvider,
    } as DashboardServerOptions);

    try {
      const apiResponse = await readResponse(new URL('/api/contexts', handle.url).toString());
      expect(apiResponse.status).toBe(404);
      expect(refreshProvider).not.toHaveBeenCalled();

      const rootResponse = await readResponse(new URL('/', handle.url).toString());
      expect(rootResponse.status).toBe(200);
      expect(rootResponse.text).toBe('<!doctype html><html><body>static</body></html>');
    } finally {
      await handle.close();
    }
  });

  it('refreshes interactive contexts, selected JSON, selected HTML, and aggregate payload from the provider', async () => {
    const outputRoot = tempDir('byomem-s101-api-');
    dirs.push(outputRoot);
    mkdirSync(outputRoot, { recursive: true });
    const refreshProvider = provider();
    const handle = await createDashboardServer({
      html: '<!doctype html><html><body>startup shell</body></html>',
      outputPath: resolve(outputRoot, 'dashboard.html'),
      host: '127.0.0.1',
      port: 0,
      interactive: true,
      refreshProvider,
    } as DashboardServerOptions);

    try {
      const contextsResponse = await readResponse(new URL('/api/contexts', handle.url).toString());
      expect(contextsResponse.status).toBe(200);
      expect(contextsResponse.headers.get('content-type')).toBe('application/json');
      expect(contextsResponse.headers.get('cache-control')).toBe('no-store');
      expect(JSON.parse(contextsResponse.text)).toMatchObject({
        refreshId: 'refresh-1',
        generatedAt: '2026-06-04T10:00:01.000Z',
        contexts: expect.arrayContaining([expect.objectContaining({ contextId: 'alpha', label: 'Alpha 1' })]),
      });

      const jsonResponse = await readResponse(new URL('/api/dashboard.json?contextId=beta', handle.url).toString());
      expect(jsonResponse.status).toBe(200);
      expect(JSON.parse(jsonResponse.text)).toMatchObject({
        refreshId: 'refresh-2',
        generatedAt: '2026-06-04T10:00:02.000Z',
        selectedContextId: 'beta',
        dashboard: expect.objectContaining({ generatedAt: '2026-06-04T10:00:02.000Z' }),
      });
      expect(jsonResponse.text).not.toContain('beta html 2');

      const htmlResponse = await readResponse(new URL('/api/dashboard.html?contextId=beta', handle.url).toString());
      expect(htmlResponse.status).toBe(200);
      expect(htmlResponse.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(htmlResponse.headers.get('cache-control')).toBe('no-store');
      expect(htmlResponse.headers.get('x-byomem-refresh-id')).toBe('refresh-3');
      expect(htmlResponse.text).toContain('beta html 3');

      const aggregateResponse = await readResponse(new URL('/api/dashboard.refresh?contextId=alpha', handle.url).toString());
      expect(aggregateResponse.status).toBe(200);
      const aggregate = JSON.parse(aggregateResponse.text);
      expect(aggregate).toMatchObject({
        refreshId: 'refresh-4',
        generatedAt: '2026-06-04T10:00:04.000Z',
        contexts: expect.arrayContaining([expect.objectContaining({ label: 'Alpha 4' })]),
        selectedContextId: 'alpha',
        dashboard: expect.objectContaining({ generatedAt: '2026-06-04T10:00:04.000Z' }),
        html: expect.stringContaining('alpha html 4'),
      });
      expect(aggregate.contexts[0].source).toBe('explicit-injection');
      expect(refreshProvider).toHaveBeenCalledTimes(4);
    } finally {
      await handle.close();
    }
  });

  it('refreshes contexts without inventing an unknown alpha context when no contextId is selected', async () => {
    const outputRoot = tempDir('byomem-s101-api-');
    dirs.push(outputRoot);
    mkdirSync(outputRoot, { recursive: true });
    const refreshProvider = vi.fn<DashboardRefreshProvider>(async ({ selectedContextId }) => {
      const contextId = selectedContextId || 'project:byomem';
      const generatedAt = '2026-06-04T10:00:00.000Z';
      return {
        generatedAt,
        refreshId: 'refresh-project-contexts',
        source: 'explicit-injection',
        selectedContextId: contextId,
        contexts: [
          { contextId: 'project:byomem', label: 'byomem', summary: 'byomem summary', source: 'explicit-injection' },
          { contextId: 'project:llm-test', label: 'llm-test', summary: 'llm-test summary', source: 'explicit-injection' },
        ],
        selectedDashboardModel: model(contextId, generatedAt),
        selectedDashboardHtml: `<!doctype html><html><body>${contextId}</body></html>`,
        warnings: [],
        errors: [],
      };
    });
    const handle = await createDashboardServer({
      html: '<!doctype html><html><body>startup shell</body></html>',
      outputPath: resolve(outputRoot, 'dashboard.html'),
      host: '127.0.0.1',
      port: 0,
      interactive: true,
      refreshProvider,
    } as DashboardServerOptions);

    try {
      const contextsResponse = await readResponse(new URL('/api/contexts', handle.url).toString());
      expect(contextsResponse.status).toBe(200);
      const payload = JSON.parse(contextsResponse.text);
      expect(payload).toMatchObject({
        refreshId: 'refresh-project-contexts',
        errors: [],
        contexts: expect.arrayContaining([
          expect.objectContaining({ contextId: 'project:byomem' }),
          expect.objectContaining({ contextId: 'project:llm-test' }),
        ]),
      });
      expect(contextsResponse.text).not.toContain('unknown-context');
      expect(refreshProvider).toHaveBeenCalledWith(expect.objectContaining({ selectedContextId: undefined }));
    } finally {
      await handle.close();
    }
  });

  it('rejects unsupported methods before invoking the refresh provider', async () => {
    const outputRoot = tempDir('byomem-s101-api-');
    dirs.push(outputRoot);
    mkdirSync(outputRoot, { recursive: true });
    const refreshProvider = provider();
    const handle = await createDashboardServer({
      html: '<!doctype html><html><body>startup shell</body></html>',
      outputPath: resolve(outputRoot, 'dashboard.html'),
      host: '127.0.0.1',
      port: 0,
      interactive: true,
      refreshProvider,
    } as DashboardServerOptions);

    try {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
        const response = await readResponse(new URL('/api/dashboard.refresh?contextId=alpha', handle.url).toString(), { method });
        expect(response.status).toBe(405);
        expect(JSON.parse(response.text)).toMatchObject({ method });
      }
      expect(refreshProvider).not.toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it('fails closed for thrown providers, partial snapshots, and removed contexts without startup fallback', async () => {
    const outputRoot = tempDir('byomem-s101-api-');
    dirs.push(outputRoot);
    mkdirSync(outputRoot, { recursive: true });
    const refreshProvider = vi.fn<DashboardRefreshProvider>(async ({ selectedContextId }) => ({
      generatedAt: '2026-06-04T10:00:00.000Z',
      refreshId: 'refresh-removed',
      source: 'explicit-injection',
      selectedContextId: selectedContextId ?? 'removed',
      contexts: [{ contextId: 'alpha', label: 'Alpha', summary: 'Alpha summary', source: 'explicit-injection' }],
      selectedDashboardModel: model('alpha', '2026-06-04T10:00:00.000Z'),
      selectedDashboardHtml: '<!doctype html><html><body>alpha fallback html</body></html>',
      warnings: [],
      errors: [{ code: 'unknown-context', message: 'Unknown dashboard context id.', contextId: selectedContextId ?? 'removed' }],
    }));
    const handle = await createDashboardServer({
      html: '<!doctype html><html><body>startup fallback must not render</body></html>',
      outputPath: resolve(outputRoot, 'dashboard.html'),
      host: '127.0.0.1',
      port: 0,
      interactive: true,
      refreshProvider,
    } as DashboardServerOptions);

    try {
      const removed = await readResponse(new URL('/api/dashboard.html?contextId=removed', handle.url).toString());
      expect(removed.status).toBe(400);
      expect(removed.headers.get('content-type')).toBe('application/json');
      expect(removed.text).not.toContain('startup fallback must not render');
      expect(removed.text).not.toContain('alpha fallback html');
    } finally {
      await handle.close();
    }
  });
});
