import { describe, expect, it } from 'vitest';
import type { DashboardModel } from '../src/dashboard.js';
import {
  createStaticDashboardRefreshProvider,
  type DashboardRefreshSnapshot,
} from '../src/dashboard-server.js';

function dashboardModel(contextId: string, generatedAt = '2026-06-04T10:00:00.000Z'): DashboardModel {
  return {
    schemaVersion: 1,
    command: 'dashboard',
    runtimeVersion: '0.0.0-test',
    generatedAt,
    overallStatus: 'pass',
    identityMeta: {
      runtimeVersion: '0.0.0-test',
      projectBaseDir: '/repo/project',
      runtimeBaseDir: '/repo/runtime',
      generatedAt,
      overallStatus: 'pass',
    },
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
      options: [{
        contextId,
        status: 'ready',
        label: `${contextId} label`,
        projectKey: contextId,
        projectDisplayName: `${contextId} project`,
        projectBaseDir: `/repo/${contextId}`,
        sessionKey: 'session-a',
        sessionLabel: 'Session A',
        roles: ['memory'],
        processCounts: { total: 1, active: 1, stale: 0, malformed: 0 },
        startedAt: generatedAt,
        lastHeartbeatAt: generatedAt,
        evidenceConfidence: 'definite',
        warnings: [],
      }],
      warnings: [],
    },
    selectedContext: {
      contextId,
      status: 'ready',
      label: `${contextId} label`,
      projectKey: contextId,
      projectDisplayName: `${contextId} project`,
      projectBaseDir: `/repo/${contextId}`,
      sessionKey: 'session-a',
      sessionLabel: 'Session A',
      roles: ['memory'],
      processCounts: { total: 1, active: 1, stale: 0, malformed: 0 },
      startedAt: generatedAt,
      lastHeartbeatAt: generatedAt,
      evidenceConfidence: 'definite',
      warnings: [],
      summary: `${contextId} summary`,
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

describe('sprint 101 dashboard refresh provider contract', () => {
  it('returns one consistent snapshot with transaction identity, contexts, selected JSON, HTML, warnings, and errors', async () => {
    const provider = createStaticDashboardRefreshProvider({
      snapshot: {
        generatedAt: '2026-06-04T10:00:00.000Z',
        refreshId: 'refresh-1',
        source: 'explicit-injection',
        selectedContextId: 'alpha',
        contexts: [{ contextId: 'alpha', label: 'Alpha', summary: 'Alpha summary', source: 'explicit-injection' }],
        selectedDashboardModel: dashboardModel('alpha'),
        selectedDashboardHtml: '<!doctype html><html><body>alpha rendered</body></html>',
        warnings: ['bounded warning'],
        errors: [],
      },
    });

    const snapshot = await provider({ selectedContextId: 'alpha' });

    expect(snapshot).toMatchObject<Partial<DashboardRefreshSnapshot>>({
      generatedAt: '2026-06-04T10:00:00.000Z',
      refreshId: 'refresh-1',
      source: 'explicit-injection',
      selectedContextId: 'alpha',
      warnings: ['bounded warning'],
      errors: [],
    });
    expect(snapshot.contexts).toHaveLength(1);
    expect(snapshot.selectedDashboardModel.generatedAt).toBe(snapshot.generatedAt);
    expect(snapshot.selectedDashboardHtml).toContain('alpha rendered');
  });

  it('fails closed for unknown context ids without falling back to a default context', async () => {
    const provider = createStaticDashboardRefreshProvider({
      snapshot: {
        generatedAt: '2026-06-04T10:00:00.000Z',
        refreshId: 'refresh-1',
        source: 'explicit-injection',
        selectedContextId: 'alpha',
        contexts: [{ contextId: 'alpha', label: 'Alpha', summary: 'Alpha summary', source: 'explicit-injection' }],
        selectedDashboardModel: dashboardModel('alpha'),
        selectedDashboardHtml: '<!doctype html><html><body>alpha rendered</body></html>',
        warnings: [],
        errors: [],
      },
    });

    const snapshot = await provider({ selectedContextId: 'removed-context' });

    expect(snapshot.selectedContextId).toBe('removed-context');
    expect(snapshot.contexts.map((context) => context.contextId)).toEqual(['alpha']);
    expect(snapshot.errors).toEqual([
      expect.objectContaining({
        code: 'unknown-context',
        message: expect.stringMatching(/unknown dashboard context/i),
        contextId: 'removed-context',
      }),
    ]);
    expect(snapshot.selectedDashboardHtml).toBe('');
    expect(JSON.stringify(snapshot.selectedDashboardModel)).not.toContain('alpha summary');
  });
});
