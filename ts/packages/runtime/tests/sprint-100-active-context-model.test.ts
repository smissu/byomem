import { describe, expect, it } from 'vitest';
import type { DoctorCheck, DoctorReport, DoctorSuggestedAction } from '../src/doctor.js';
import type { DashboardModel } from '../src/dashboard.js';
import type { StatusArtifactFile, StatusReport } from '../src/status-report.js';
import { BYOMEM_RUNTIME_VERSION } from '../src/version.js';
import { buildByomemDashboardModel, renderByomemDashboardHtml } from '../src/dashboard.js';

const generatedAt = '2026-06-04T00:00:00.000Z';
const projectBaseDir = '/Users/alice/work/project-one';
const runtimeBaseDir = '/Users/alice/work/project-one/.byomem/runtime';

type DashboardContextOption = {
  contextId: string;
  status: 'ready' | 'degraded' | 'stale' | 'unknown';
  label: string;
  projectKey: string | null;
  projectDisplayName: string | null;
  projectBaseDir: string | null;
  sessionKey: string | null;
  sessionLabel: string | null;
  roles: string[];
  processCounts: {
    total: number;
    active: number;
    stale: number;
    malformed: number;
  };
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  evidenceConfidence: 'definite' | 'constrained' | 'not-applicable';
  warnings: string[];
};

type SelectedContextMetadata = DashboardContextOption & {
  summary: string;
};

type DashboardModelWithActiveContext = DashboardModel & {
  activeContext: {
    selectedContextId: string;
    options: DashboardContextOption[];
    warnings: string[];
  };
  selectedContext: SelectedContextMetadata;
};

function action(label: string, command: string): DoctorSuggestedAction {
  return { label, command, mode: 'read-only' };
}

function artifactFile(path: string, exists: boolean): StatusArtifactFile {
  return {
    path,
    exists,
    sizeBytes: exists ? 42 : null,
    mtimeMs: exists ? 1717113600000 : null,
    mtime: exists ? generatedAt : null,
  };
}

function statusReport(overrides: Partial<StatusReport> = {}): StatusReport {
  const memoryJson = artifactFile(`${runtimeBaseDir}/native-store.json`, true);
  const memorySqlite = artifactFile(`${runtimeBaseDir}/byomem-index.sqlite`, true);
  const fileSearchSqlite = artifactFile(`${runtimeBaseDir}/byomem-file-search.sqlite`, true);
  const graphSqlite = artifactFile(`${runtimeBaseDir}/byomem-graph.sqlite`, true);

  return {
    version: BYOMEM_RUNTIME_VERSION,
    runtimeVersion: BYOMEM_RUNTIME_VERSION,
    generatedAt,
    projectBaseDir,
    runtimeBaseDir,
    projectKey: 'project-one',
    paths: {
      memory: { json: memoryJson.path, sqlite: memorySqlite.path },
      fileSearch: { sqlite: fileSearchSqlite.path },
      graph: { sqlite: graphSqlite.path },
    },
    artifacts: {
      memory: { status: 'ready', warnings: [], json: memoryJson, sqlite: memorySqlite },
      fileSearch: { status: 'ready', warnings: [], sqlite: fileSearchSqlite },
      graph: { status: 'ready', warnings: [], sqlite: graphSqlite },
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
    ...overrides,
  };
}

function check(overrides: Partial<DoctorCheck> & Pick<DoctorCheck, 'id' | 'component' | 'status' | 'severity' | 'title'>): DoctorCheck {
  return {
    evidenceConfidence: 'definite',
    evidence: {},
    warnings: [],
    suggestedActions: [],
    skippedReason: null,
    ...overrides,
  };
}

function runtimeStateRecord(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    role: 'memory',
    serverName: 'byomem-mcp-memory',
    pid: 101,
    ppid: 1,
    entrypoint: 'mcp-memory',
    runtimeVersion: BYOMEM_RUNTIME_VERSION,
    startedAt: '2026-06-04T00:00:01.000Z',
    lastHeartbeatAt: '2026-06-04T00:10:01.000Z',
    state: 'active',
    staleReason: null,
    ...overrides,
  };
}

function runtimeStateLivenessCheck(records: Record<string, unknown>[], warnings: string[] = []): DoctorCheck {
  return check({
    id: 'runtime-state.process-liveness',
    component: 'runtime-state',
    status: 'warn',
    severity: 'medium',
    title: 'Runtime process records have active context identity',
    evidenceConfidence: 'constrained',
    evidence: {
      counts: { total: records.length, active: records.length, stale: 0, malformed: 0 },
      records,
      malformed: [],
      duplicateActiveRoles: [],
    },
    warnings,
    suggestedActions: [action('Inspect runtime status', `byomem-runtime status --base-dir ${runtimeBaseDir}`)],
  });
}

function doctorReport(records: Record<string, unknown>[], overrides: Partial<DoctorReport> = {}): DoctorReport {
  return {
    command: 'doctor',
    version: BYOMEM_RUNTIME_VERSION,
    runtimeVersion: BYOMEM_RUNTIME_VERSION,
    generatedAt,
    projectBaseDir,
    runtimeBaseDir,
    overallStatus: 'warn',
    checks: [
      check({
        id: 'version.runtime-alignment',
        component: 'version',
        status: 'pass',
        severity: 'info',
        title: 'Runtime version files are aligned',
        evidence: { runtimeVersionConstant: BYOMEM_RUNTIME_VERSION },
        suggestedActions: [action('Inspect version files', 'grep -n "version" package.json')],
      }),
      runtimeStateLivenessCheck(records, ['Active context identity is not yet projected into the dashboard model.']),
    ],
    warnings: ['Active context identity is not yet projected into the dashboard model.'],
    suggestedActions: [action('Inspect status', `byomem-runtime status --base-dir ${runtimeBaseDir}`)],
    ...overrides,
  };
}

function buildActiveContextModel(records: Record<string, unknown>[]): DashboardModelWithActiveContext {
  return buildByomemDashboardModel({
    statusReport: statusReport({
      mcpProcesses: {
        source: 'runtime-state',
        count: records.length,
        roles: ['memory'],
        duplicateActiveRoles: [],
        staleCount: 0,
        malformedCount: 0,
        warnings: ['Active context identity is not yet projected into the dashboard model.'],
      },
      warnings: ['Active context identity is not yet projected into the dashboard model.'],
    }),
    doctorReport: doctorReport(records),
    generatedAt,
  }) as DashboardModelWithActiveContext;
}

describe('sprint 100 active context model contract', () => {
  it('exposes bounded active context options and selected context metadata', () => {
    const model = buildActiveContextModel([
      runtimeStateRecord({
        pid: 101,
        path: '/Users/alice/work/project-one/.byomem/runtime/runtime-state/processes/memory-101.json',
        cwd: '/Users/alice/work/project-one',
        identity: {
          projectKey: 'project-one',
          projectDisplayName: 'Project One',
          projectBaseDir: '/Users/alice/work/project-one',
          projectSource: 'explicit',
          sessionKey: 'session-a',
          sessionLabel: 'Session A',
          clientInstanceId: 'client-a',
        },
      }),
    ]);

    expect(model.activeContext).toEqual(
      expect.objectContaining({
        selectedContextId: 'project-one:session-a',
        warnings: [],
        options: [
          expect.objectContaining({
            contextId: 'project-one:session-a',
            status: 'ready',
            label: 'Project One / Session A',
            projectKey: 'project-one',
            projectDisplayName: 'Project One',
            projectBaseDir: '/Users/alice/work/project-one',
            sessionKey: 'session-a',
            sessionLabel: 'Session A',
            roles: ['memory'],
            processCounts: {
              total: 1,
              active: 1,
              stale: 0,
              malformed: 0,
            },
            startedAt: '2026-06-04T00:00:01.000Z',
            lastHeartbeatAt: '2026-06-04T00:10:01.000Z',
            evidenceConfidence: 'definite',
            warnings: [],
          }),
        ],
      }),
    );
    expect(model.selectedContext).toEqual(
      expect.objectContaining({
        contextId: 'project-one:session-a',
        status: 'ready',
        label: 'Project One / Session A',
        summary: expect.not.stringContaining('/Users/alice/work/project-one/.byomem/runtime/runtime-state/processes/memory-101.json'),
        projectKey: 'project-one',
        projectDisplayName: 'Project One',
        projectBaseDir: '/Users/alice/work/project-one',
        sessionKey: 'session-a',
        sessionLabel: 'Session A',
        roles: ['memory'],
        processCounts: {
          total: 1,
          active: 1,
          stale: 0,
          malformed: 0,
        },
        startedAt: '2026-06-04T00:00:01.000Z',
        lastHeartbeatAt: '2026-06-04T00:10:01.000Z',
        evidenceConfidence: 'definite',
        warnings: [],
      }),
    );
  });

  it('keeps same-role records from different projects and sessions distinct instead of grouping by cwd', () => {
    const model = buildActiveContextModel([
      runtimeStateRecord({
        pid: 101,
        path: '/Users/alice/work/project-one/.byomem/runtime/runtime-state/processes/memory-101.json',
        cwd: '/Users/alice/work/shared-cwd',
        identity: {
          projectKey: 'project-one',
          projectDisplayName: 'Project One',
          projectBaseDir: '/Users/alice/work/project-one',
          projectSource: 'explicit',
          sessionKey: 'session-a',
          sessionLabel: 'Session A',
          clientInstanceId: 'client-a',
        },
      }),
      runtimeStateRecord({
        pid: 202,
        serverName: 'byomem-mcp-memory-second',
        entrypoint: 'mcp-memory',
        path: '/Users/alice/work/project-two/.byomem/runtime/runtime-state/processes/memory-202.json',
        cwd: '/Users/alice/work/shared-cwd',
        identity: {
          projectKey: 'project-two',
          projectDisplayName: 'Project Two',
          projectBaseDir: '/Users/alice/work/project-two',
          projectSource: 'explicit',
          sessionKey: 'session-b',
          sessionLabel: 'Session B',
          clientInstanceId: 'client-b',
        },
      }),
    ]);

    expect(model.activeContext).toEqual(
      expect.objectContaining({
        selectedContextId: 'project-one:session-a',
        options: expect.arrayContaining([
          expect.objectContaining({
            contextId: 'project-one:session-a',
            label: 'Project One / Session A',
            projectKey: 'project-one',
            sessionKey: 'session-a',
            roles: ['memory'],
          }),
          expect.objectContaining({
            contextId: 'project-two:session-b',
            label: 'Project Two / Session B',
            projectKey: 'project-two',
            sessionKey: 'session-b',
            roles: ['memory'],
          }),
        ]),
      }),
    );
    expect(model.activeContext.options).toHaveLength(2);
    expect(model.activeContext.options.map((option) => option.contextId)).toEqual([
      'project-one:session-a',
      'project-two:session-b',
    ]);
    expect(model.activeContext.options.map((option) => option.label)).not.toContain('/Users/alice/work/shared-cwd');
  });

  it('groups legacy no-identity active MCP session records under the active project instead of a PID list', () => {
    const model = buildActiveContextModel([
      runtimeStateRecord({
        pid: 301,
        role: 'memory',
        serverName: 'byomem-mcp-memory',
        path: '/Users/alice/work/project-one/.byomem/runtime/runtime-state/processes/memory-301.json',
        cwd: '/Users/alice/work/project-one',
        identity: null,
      }),
      runtimeStateRecord({
        pid: 302,
        role: 'graph',
        serverName: 'byomem-mcp-graph',
        entrypoint: 'mcp-graph',
        path: '/Users/alice/work/project-two/.byomem/runtime/runtime-state/processes/graph-302.json',
        cwd: '/Users/alice/work/project-two',
        identity: null,
      }),
      runtimeStateRecord({
        pid: 303,
        role: 'readonly',
        serverName: 'byomem-mcp-readonly',
        entrypoint: 'mcp-readonly',
        path: '/Users/alice/work/project-three/.byomem/runtime/runtime-state/processes/readonly-303.json',
        cwd: '/Users/alice/work/project-three',
        identity: null,
      }),
    ]);

    expect(model.activeContext.options).toHaveLength(1);
    expect(model.activeContext.options[0]).toEqual(expect.objectContaining({
      contextId: 'project:project-one',
      label: 'project-one (3 MCP sessions)',
      projectKey: 'project-one',
      projectDisplayName: 'project-one',
      roles: ['graph', 'memory', 'readonly'],
      processCounts: { total: 3, active: 3, stale: 0, malformed: 0 },
    }));
    expect(JSON.stringify(model.activeContext.options)).not.toContain('/Users/alice/work/');
    expect(JSON.stringify(model.activeContext.options)).not.toContain('memory-301.json');
  });

  it('groups project-only runtime identities by project for the context dropdown', () => {
    const model = buildActiveContextModel([
      runtimeStateRecord({
        pid: 401,
        role: 'memory',
        serverName: 'byomem-mcp-memory',
        entrypoint: 'mcp-memory',
        path: '/Users/alice/work/otp-live/.byomem/runtime/runtime-state/processes/memory-401.json',
        cwd: '/Users/alice/work/otp-live',
        identity: {
          projectKey: 'otp-live',
          projectDisplayName: 'otp-live',
          projectBaseDir: '/Users/alice/work/otp-live',
          projectSource: 'active-project',
          sessionKey: null,
          sessionLabel: null,
          clientInstanceId: null,
        },
      }),
      runtimeStateRecord({
        pid: 402,
        role: 'graph',
        serverName: 'byomem-mcp-graph',
        entrypoint: 'mcp-graph',
        path: '/Users/alice/work/otp-live/.byomem/runtime/runtime-state/processes/graph-402.json',
        cwd: '/Users/alice/work/otp-live',
        identity: {
          projectKey: 'otp-live',
          projectDisplayName: 'otp-live',
          projectBaseDir: '/Users/alice/work/otp-live',
          projectSource: 'active-project',
          sessionKey: null,
          sessionLabel: null,
          clientInstanceId: null,
        },
      }),
      runtimeStateRecord({
        pid: 403,
        role: 'file-search',
        serverName: 'byomem-mcp-file-search',
        entrypoint: 'mcp-file-search',
        path: '/Users/alice/work/llm-test/.byomem/runtime/runtime-state/processes/file-search-403.json',
        cwd: '/Users/alice/work/llm-test',
        identity: {
          projectKey: 'llm-test',
          projectDisplayName: 'llm-test',
          projectBaseDir: '/Users/alice/work/llm-test',
          projectSource: 'active-project',
          sessionKey: null,
          sessionLabel: null,
          clientInstanceId: null,
        },
      }),
    ]);

    expect(model.activeContext.options).toEqual([
      expect.objectContaining({
        contextId: 'project:llm-test',
        label: 'llm-test (1 MCP session)',
        projectKey: 'llm-test',
        sessionKey: null,
        roles: ['file-search'],
        processCounts: { total: 1, active: 1, stale: 0, malformed: 0 },
      }),
      expect.objectContaining({
        contextId: 'project:otp-live',
        label: 'otp-live (2 MCP sessions)',
        projectKey: 'otp-live',
        sessionKey: null,
        roles: ['graph', 'memory'],
        processCounts: { total: 2, active: 2, stale: 0, malformed: 0 },
      }),
    ]);
    expect(model.activeContext.options.map((option) => option.label).join('\n')).not.toContain('/Users/alice/work/');
  });

  it('keeps unknown ids, collisions, truncation warnings, and raw paths deterministic and bounded', () => {
    const records = Array.from({ length: 30 }, (_, index) => runtimeStateRecord({
      pid: 100 + index,
      serverName: `byomem-mcp-memory-${String(index).padStart(2, '0')}`,
      path: `/Users/alice/work/project-one/.byomem/runtime/runtime-state/processes/memory-${String(index).padStart(2, '0')}.json`,
      cwd: index % 2 === 0 ? '/Users/alice/work/project-one' : '/Users/alice/work/project-two',
      identity: index < 2
        ? {
            projectKey: 'project-one',
            projectDisplayName: 'Project One',
            projectBaseDir: '/Users/alice/work/project-one',
            projectSource: 'explicit',
            sessionKey: 'shared-session',
            sessionLabel: 'Shared Session',
            clientInstanceId: `client-${index}`,
          }
        : null,
    }));
    const model = buildActiveContextModel(records);

    expect(model.activeContext).toEqual(
      expect.objectContaining({
        warnings: expect.arrayContaining([
          expect.stringMatching(/unknown/i),
          expect.stringMatching(/collision/i),
          expect.stringMatching(/truncat/i),
        ]),
        options: expect.arrayContaining([
          expect.objectContaining({
            contextId: expect.stringMatching(/project-one:shared-session/i),
            label: expect.not.stringContaining('/Users/alice/work/project-one/.byomem/runtime/runtime-state/processes/'),
          }),
        ]),
      }),
    );
    expect(model.activeContext.options.length).toBeLessThanOrEqual(24);
    expect(model.selectedContext.summary).not.toContain('/Users/alice/work/project-one/.byomem/runtime/runtime-state/processes/');
  });
});

describe('sprint 100 static context summary renderer', () => {
  it('renders the selected context and summary in static HTML without interactive controls or raw API tokens', () => {
    const model = buildByomemDashboardModel({
      statusReport: statusReport({
        mcpProcesses: {
          source: 'runtime-state',
          count: 2,
          roles: ['memory'],
          duplicateActiveRoles: [],
          staleCount: 0,
          malformedCount: 0,
          warnings: [],
        },
      }),
      doctorReport: doctorReport([
        runtimeStateRecord({
          pid: 101,
          path: '/Users/alice/work/project-one/.byomem/runtime/runtime-state/processes/memory-101.json',
          identity: {
            projectKey: 'project-one',
            projectDisplayName: 'Project One',
            projectBaseDir: '/Users/alice/work/project-one',
            projectSource: 'explicit',
            sessionKey: 'session-a',
            sessionLabel: 'Session A',
            clientInstanceId: 'client-a',
          },
        }),
        runtimeStateRecord({
          pid: 202,
          serverName: 'byomem-mcp-memory-second',
          path: '/Users/alice/work/project-two/.byomem/runtime/runtime-state/processes/memory-202.json',
          identity: {
            projectKey: 'project-two',
            projectDisplayName: 'Project Two',
            projectBaseDir: '/Users/alice/work/project-two',
            projectSource: 'explicit',
            sessionKey: 'session-b',
            sessionLabel: 'Session B',
            clientInstanceId: 'client-b',
          },
        }),
      ]),
      generatedAt,
    }) as DashboardModelWithActiveContext;

    const htmlModel = {
      ...model,
      activeContext: {
        selectedContextId: 'project-one:session-a',
        warnings: [],
        options: [
          {
            contextId: 'project-one:session-a',
            status: 'ready',
            label: 'Project One / Session A',
            projectKey: 'project-one',
            projectDisplayName: 'Project One',
            projectBaseDir: '/Users/alice/work/project-one',
            sessionKey: 'session-a',
            sessionLabel: 'Session A',
            roles: ['memory'],
            processCounts: { total: 1, active: 1, stale: 0, malformed: 0 },
            startedAt: '2026-06-04T00:00:01.000Z',
            lastHeartbeatAt: '2026-06-04T00:10:01.000Z',
            evidenceConfidence: 'definite',
            warnings: [],
          },
        ],
      },
      selectedContext: {
        contextId: 'project-one:session-a',
        status: 'ready',
        label: 'Project One / Session A',
        summary: 'Selected context summary for Project One / Session A',
        projectKey: 'project-one',
        projectDisplayName: 'Project One',
        projectBaseDir: '/Users/alice/work/project-one',
        sessionKey: 'session-a',
        sessionLabel: 'Session A',
        roles: ['memory'],
        processCounts: { total: 1, active: 1, stale: 0, malformed: 0 },
        startedAt: '2026-06-04T00:00:01.000Z',
        lastHeartbeatAt: '2026-06-04T00:10:01.000Z',
        evidenceConfidence: 'definite',
        warnings: [],
      },
    } as DashboardModelWithActiveContext;

    const html = renderByomemDashboardHtml(htmlModel);

    expect(html).toContain('Selected context');
    expect(html).toContain('Selected context summary');
    expect(html).toContain('Project One / Session A');
    expect(html).toContain('Session A');
    expect(html).toContain('context summary');
    expect(html).toContain('&lt;');
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<select\b/i);
    expect(html).not.toMatch(/<option\b/i);
    expect(html).not.toContain('data-context');
    expect(html).not.toContain('/api/');
    expect(html).not.toMatch(/<form\b/i);
    expect(html).not.toMatch(/<button\b/i);
    expect(html).not.toMatch(/\bon[a-z]+\s*=/i);
    expect(html).not.toMatch(/\b(?:src|href|action)\s*=\s*["'](?:https?:)?\/\//i);
  });
});
