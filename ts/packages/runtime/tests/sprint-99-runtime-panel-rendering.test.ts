import { describe, expect, it } from 'vitest';
import { renderByomemDashboardHtml } from '../src/dashboard.js';

function dashboardModel(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    command: 'dashboard',
    runtimeVersion: '0.1.23',
    generatedAt: '2026-06-02T00:00:00.000Z',
    overallStatus: 'warn',
    projectBaseDir: '/repo',
    runtimeBaseDir: '/runtime',
    degradedComponents: ['runtime-state'],
    statusComponents: [],
    doctorChecks: [],
    warnings: [],
    suggestedActions: [],
    runtimeProcesses: {
      source: 'runtime-state',
      evidenceTier: 'stat-only',
      evidenceConfidence: 'constrained',
      status: 'degraded',
      summary: '2 active and 1 stale runtime process records need review.',
      counts: { total: 3, active: 2, stale: 1, malformed: 1 },
      roles: ['file-search', 'memory'],
      duplicateActiveRoles: [
        {
          role: 'memory',
          count: 2,
          records: [
            { pid: 101, serverName: 'byomem-mcp-memory', entrypoint: 'mcp-memory', path: '/runtime/runtime-state/processes/memory-101-a.json' },
            { pid: 202, serverName: 'byomem-mcp-memory', entrypoint: 'mcp-memory', path: '/runtime/runtime-state/processes/memory-202-b.json' },
          ],
        },
      ],
      records: [
        {
          role: 'memory',
          serverName: 'byomem-mcp-memory',
          pid: 101,
          ppid: 1,
          entrypoint: 'mcp-memory',
          runtimeVersion: '0.1.23',
          startedAt: '2026-06-02T00:00:01.000Z',
          lastHeartbeatAt: '2026-06-02T00:10:01.000Z',
          state: 'active',
          staleReason: null,
          path: '/runtime/runtime-state/processes/memory-101-a.json',
        },
        {
          role: 'file-search',
          serverName: 'byomem-mcp-file-search',
          pid: 303,
          ppid: 1,
          entrypoint: 'mcp-file-search',
          runtimeVersion: '0.1.23',
          startedAt: '2026-06-02T00:00:03.000Z',
          lastHeartbeatAt: '2026-06-02T00:10:03.000Z',
          state: 'stale',
          staleReason: 'pid-not-running',
          path: '/runtime/runtime-state/processes/file-search-303-c.json',
        },
      ],
      malformed: [
        { path: '/runtime/runtime-state/processes/bad.json', error: 'record <bad> & invalid "json"' },
      ],
      warnings: ['PID liveness evidence is constrained; stale records require isolated confirmation before cleanup.'],
    },
    ...overrides,
  };
}

describe('sprint 99 runtime process panel renderer', () => {
  it('renders a static Runtime processes nav item and section with liveness evidence', () => {
    const html = renderByomemDashboardHtml(dashboardModel());

    expect(html).toContain('Runtime processes');
    expect(html).toContain('#runtime-processes');
    expect(html).toContain('constrained');
    expect(html).toContain('runtime-state');
    expect(html).toContain('file-search');
    expect(html).toContain('memory');
    expect(html).toContain('byomem-mcp-memory');
    expect(html).toContain('mcp-file-search');
    expect(html).toContain('pid-not-running');
    expect(html).toContain('Malformed');
    expect(html).toContain('Duplicate active roles');
  });

  it('escapes dynamic process fields and keeps the dashboard static', () => {
    const html = renderByomemDashboardHtml(dashboardModel({
      runtimeProcesses: {
        ...(dashboardModel().runtimeProcesses as Record<string, unknown>),
        roles: ['memory<script>alert(1)</script>'],
        records: [
          {
            role: 'memory<script>alert(1)</script>',
            serverName: 'server<img src=x onerror=alert(1)>',
            pid: 404,
            ppid: 1,
            entrypoint: 'entry<svg onload=alert(1)>',
            runtimeVersion: '0.1.23',
            startedAt: '2026-06-02T00:00:04.000Z',
            lastHeartbeatAt: '2026-06-02T00:10:04.000Z',
            state: 'active',
            staleReason: null,
            path: '/runtime/<danger>/process.json',
          },
        ],
        malformed: [
          { path: '/runtime/bad.json', error: 'bad <iframe src=x></iframe>' },
        ],
      },
    }));

    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<form\b/i);
    expect(html).not.toMatch(/<button\b/i);
    expect(html).not.toMatch(/\bon[a-z]+\s*=/i);
    expect(html).not.toMatch(/\b(?:src|action)\s*=\s*["'](?:https?:)?\/\//i);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('<iframe');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('server&lt;img src=x onerror&#61;alert(1)&gt;');
    expect(html).toContain('entry&lt;svg onload&#61;alert(1)&gt;');
    expect(html).toContain('/runtime/&lt;danger&gt;/process.json');
  });

  it('renders an empty or missing runtime process panel without executable actions', () => {
    const html = renderByomemDashboardHtml(dashboardModel({
      runtimeProcesses: {
        source: 'runtime-state',
        evidenceTier: 'stat-only',
        evidenceConfidence: 'not-applicable',
        status: 'missing',
        summary: 'Runtime process state directory is missing.',
        counts: { total: 0, active: 0, stale: 0, malformed: 0 },
        roles: [],
        duplicateActiveRoles: [],
        records: [],
        malformed: [],
        warnings: ['runtime process state directory is missing: /runtime/runtime-state/processes'],
      },
    }));

    expect(html).toContain('Runtime processes');
    expect(html).toContain('missing');
    expect(html).toContain('not-applicable');
    expect(html).toContain('None.');
    expect(html).not.toMatch(/\b(cleanup|stop|kill)\b.*<button/i);
  });

  it('renders duplicate role overflow warnings without unbounded duplicate records', () => {
    const duplicateActiveRoles = Array.from({ length: 24 }, (_, roleIndex) => ({
      role: `role-${String(roleIndex).padStart(2, '0')}`,
      count: 16,
      records: Array.from({ length: 12 }, (_, recordIndex) => ({
        pid: roleIndex * 100 + recordIndex,
        serverName: `byomem-mcp-role-${roleIndex}`,
        entrypoint: 'mcp-memory',
        path: `/runtime/runtime-state/processes/role-${roleIndex}-${recordIndex}.json`,
      })),
    }));
    const html = renderByomemDashboardHtml(dashboardModel({
      runtimeProcesses: {
        ...(dashboardModel().runtimeProcesses as Record<string, unknown>),
        duplicateActiveRoles,
        warnings: [
          'Duplicate active role summaries were truncated to 24 roles; additional roles were omitted.',
          'Duplicate active role records were truncated to 12 records per role; additional records were omitted.',
        ],
      },
    }));

    expect(html).toContain('Duplicate active role summaries were truncated to 24 roles');
    expect(html).toContain('Duplicate active role records were truncated to 12 records per role');
    expect(html).toContain('role-23');
    expect(html).not.toContain('role-24');
    expect(html).not.toContain('/runtime/runtime-state/processes/role-0-12.json');
  });
});
