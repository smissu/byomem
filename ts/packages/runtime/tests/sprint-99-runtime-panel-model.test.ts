import { describe, expect, it } from 'vitest';
import type { DoctorCheck, DoctorReport, DoctorSuggestedAction } from '../src/doctor.js';
import type { DashboardModel } from '../src/dashboard.js';
import type { StatusArtifactFile, StatusReport } from '../src/status-report.js';
import { BYOMEM_RUNTIME_VERSION } from '../src/version.js';
import { buildByomemDashboardModel } from '../src/dashboard.js';

const generatedAt = '2026-05-31T00:00:00.000Z';
const projectBaseDir = '/repo';
const runtimeBaseDir = '/runtime';
const runtimeStateWarning = 'Runtime process inventory is stale and needs review.';
const livenessWarning = 'PID liveness evidence is constrained; stale records require isolated confirmation before cleanup.';

type RuntimeProcessDuplicateRecord = {
  pid: number | null;
  serverName: string | null;
  entrypoint: string | null;
  path: string;
};

type RuntimeProcessDuplicateSummary = {
  role: string;
  count: number;
  records: RuntimeProcessDuplicateRecord[];
};

type RuntimeProcessRecord = {
  role: string;
  serverName: string;
  pid: number;
  ppid: number | null;
  entrypoint: string;
  runtimeVersion: string | null;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  state: 'active' | 'stale';
  staleReason: 'pid-not-running' | 'heartbeat-expired' | null;
  path: string;
};

type RuntimeProcessesPanel = {
  source: 'runtime-state';
  evidenceTier: 'stat-only';
  evidenceConfidence: 'definite' | 'constrained' | 'not-applicable';
  status: 'ready' | 'degraded' | 'missing';
  counts: {
    total: number;
    active: number;
    stale: number;
    malformed: number;
  };
  roles: string[];
  duplicateActiveRoles: RuntimeProcessDuplicateSummary[];
  records: RuntimeProcessRecord[];
  malformed: Array<{
    path: string;
    error: string;
  }>;
  warnings: string[];
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
    projectKey: 'repo',
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

function check(
  overrides: Partial<DoctorCheck> & Pick<DoctorCheck, 'id' | 'component' | 'status' | 'severity' | 'title'>,
): DoctorCheck {
  return {
    evidenceConfidence: 'definite',
    evidence: {},
    warnings: [],
    suggestedActions: [],
    skippedReason: null,
    ...overrides,
  };
}

function processRecord(index: number, state: 'active' | 'stale'): RuntimeProcessRecord {
  const suffix = String(index).padStart(2, '0');
  return {
    role: index % 2 === 0 ? 'memory' : 'graph',
    serverName: index % 2 === 0 ? 'byomem-mcp-memory' : 'byomem-mcp-graph',
    pid: 100 + index,
    ppid: 1,
    entrypoint: index % 2 === 0 ? 'mcp-memory' : 'mcp-graph',
    runtimeVersion: BYOMEM_RUNTIME_VERSION,
    startedAt: `${generatedAt.slice(0, 10)}T00:00:${suffix}.000Z`,
    lastHeartbeatAt: `${generatedAt.slice(0, 10)}T00:10:${suffix}.000Z`,
    state,
    staleReason: state === 'stale' ? (index % 4 === 0 ? 'heartbeat-expired' : 'pid-not-running') : null,
    path: `${runtimeBaseDir}/runtime-state/processes/${index % 2 === 0 ? 'memory' : 'graph'}-${100 + index}.json`,
  };
}

function malformedRecord(index: number): { path: string; error: string } {
  return {
    path: `${runtimeBaseDir}/runtime-state/processes/malformed-${String(index).padStart(2, '0')}.json`,
    error: `Malformed runtime process JSON ${index}`,
  };
}

function duplicateRecord(index: number): RuntimeProcessDuplicateRecord {
  const suffix = String(index).padStart(2, '0');
  return {
    pid: 1000 + index,
    serverName: `byomem-mcp-memory-${suffix}`,
    entrypoint: 'mcp-memory',
    path: `${runtimeBaseDir}/runtime-state/processes/memory-${suffix}.json`,
  };
}

function duplicateSummary(index: number, recordCount = 2): RuntimeProcessDuplicateSummary {
  const suffix = String(index).padStart(2, '0');
  return {
    role: `role-${suffix}`,
    count: recordCount,
    records: Array.from({ length: recordCount }, (_, recordIndex) => duplicateRecord(index * 100 + recordIndex)),
  };
}

function runtimeStateLivenessCheck(overrides: Partial<DoctorCheck['evidence']> = {}): DoctorCheck {
  const duplicateSummary: RuntimeProcessDuplicateSummary = {
    role: 'memory',
    count: 2,
    records: [
      {
        pid: 101,
        serverName: 'byomem-mcp-memory',
        entrypoint: 'mcp-memory',
        path: `${runtimeBaseDir}/runtime-state/processes/memory-101-a.json`,
      },
      {
        pid: 202,
        serverName: 'byomem-mcp-memory',
        entrypoint: 'mcp-memory',
        path: `${runtimeBaseDir}/runtime-state/processes/memory-202-b.json`,
      },
    ],
  };
  return check({
    id: 'runtime-state.process-liveness',
    component: 'runtime-state',
    status: 'warn',
    severity: 'medium',
    title: 'Runtime process records have consistent liveness evidence',
    evidenceConfidence: 'constrained',
    evidence: {
      counts: { total: 30, active: 27, stale: 3, malformed: 30 },
      duplicateActiveRoles: ['memory'],
      duplicateActiveRoleSummaries: [duplicateSummary],
      records: Array.from({ length: 30 }, (_, index) => processRecord(index, index < 27 ? 'active' : 'stale')),
      malformed: Array.from({ length: 30 }, (_, index) => malformedRecord(index)),
      ...overrides,
    },
    warnings: [livenessWarning],
    suggestedActions: [action('Inspect runtime status', `byomem-runtime status --base-dir ${runtimeBaseDir}`)],
    skippedReason: null,
  });
}

function doctorReport(overrides: Partial<DoctorReport> = {}): DoctorReport {
  return {
    command: 'doctor',
    version: BYOMEM_RUNTIME_VERSION,
    runtimeVersion: BYOMEM_RUNTIME_VERSION,
    generatedAt,
    projectBaseDir,
    runtimeBaseDir,
    overallStatus: 'pass',
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
      check({
        id: 'runtime-state.inventory',
        component: 'runtime-state',
        status: 'pass',
        severity: 'info',
        title: 'Runtime process inventory is readable',
        evidence: {
          counts: { total: 30, active: 27, stale: 3, malformed: 30 },
        },
      }),
      runtimeStateLivenessCheck(),
      check({
        id: 'runtime-info.active-mcp',
        component: 'runtime-info',
        status: 'skipped',
        severity: 'info',
        title: 'Active MCP runtime-info verification is deferred',
        evidenceConfidence: 'not-applicable',
        evidence: { reason: 'Active MCP runtime-info verification belongs to later health/verification work.' },
        skippedReason: 'Active MCP runtime-info verification belongs to later health/verification work.',
      }),
    ],
    warnings: [runtimeStateWarning, livenessWarning],
    suggestedActions: [
      action('Inspect status', `byomem-runtime status --base-dir ${runtimeBaseDir}`),
      action('Inspect doctor', `byomem-runtime doctor --base-dir ${runtimeBaseDir} --json`),
    ],
    ...overrides,
  };
}

describe('sprint 99 runtime process panel model contract', () => {
  it('builds a top-level runtimeProcesses panel from injected status and doctor evidence', () => {
    const report = buildByomemDashboardModel({
      statusReport: statusReport({
        mcpProcesses: {
          source: 'runtime-state',
          count: 30,
          roles: ['bootstrap', 'graph', 'memory', 'readonly'],
          duplicateActiveRoles: [
            {
              role: 'memory',
              count: 2,
              records: [
                {
                  pid: 101,
                  serverName: 'byomem-mcp-memory',
                  entrypoint: 'mcp-memory',
                  path: `${runtimeBaseDir}/runtime-state/processes/memory-101-a.json`,
                },
                {
                  pid: 202,
                  serverName: 'byomem-mcp-memory',
                  entrypoint: 'mcp-memory',
                  path: `${runtimeBaseDir}/runtime-state/processes/memory-202-b.json`,
                },
              ],
            },
          ],
          staleCount: 3,
          malformedCount: 30,
          warnings: [runtimeStateWarning],
        },
        warnings: [runtimeStateWarning],
        degradedComponents: ['memory'],
      }),
      doctorReport: doctorReport({
        checks: [
          check({
            id: 'version.runtime-alignment',
            component: 'version',
            status: 'pass',
            severity: 'info',
            title: 'Runtime version files are aligned',
            evidence: { runtimeVersionConstant: BYOMEM_RUNTIME_VERSION },
          }),
          check({
            id: 'runtime-state.inventory',
            component: 'runtime-state',
            status: 'pass',
            severity: 'info',
            title: 'Runtime process inventory is readable',
            evidence: {
              counts: { total: 30, active: 27, stale: 3, malformed: 30 },
            },
          }),
          runtimeStateLivenessCheck(),
        ],
        warnings: [runtimeStateWarning, livenessWarning],
      }),
      generatedAt,
    }) as DashboardModel & { runtimeProcesses?: RuntimeProcessesPanel };

    expect(report).toHaveProperty('runtimeProcesses');
    expect(report.runtimeProcesses).toEqual(
      expect.objectContaining({
        source: 'runtime-state',
        evidenceTier: 'stat-only',
        evidenceConfidence: 'constrained',
        status: 'degraded',
        counts: {
          total: 30,
          active: 27,
          stale: 3,
          malformed: 30,
        },
        roles: ['bootstrap', 'graph', 'memory', 'readonly'],
        duplicateActiveRoles: expect.arrayContaining([
          expect.objectContaining({
            role: 'memory',
            count: 2,
            records: expect.arrayContaining([
              expect.objectContaining({
                pid: 101,
                serverName: 'byomem-mcp-memory',
                entrypoint: 'mcp-memory',
                path: `${runtimeBaseDir}/runtime-state/processes/memory-101-a.json`,
              }),
            ]),
          }),
        ]),
        warnings: expect.arrayContaining([runtimeStateWarning, livenessWarning, expect.stringMatching(/truncat|omitted/i)]),
      }),
    );
    expect(report.runtimeProcesses?.records?.length ?? 0).toBeLessThanOrEqual(24);
    expect(report.runtimeProcesses?.malformed?.length ?? 0).toBeLessThanOrEqual(24);
    expect(report.runtimeProcesses?.warnings ?? []).toEqual(expect.arrayContaining([runtimeStateWarning, livenessWarning]));
  });

  it('bounds duplicate active role summaries and nested records with overflow warnings', () => {
    const duplicateActiveRoles = Array.from({ length: 30 }, (_, index) => duplicateSummary(index, 16));
    const report = buildByomemDashboardModel({
      statusReport: statusReport({
        mcpProcesses: {
          source: 'runtime-state',
          count: 60,
          roles: duplicateActiveRoles.map((entry) => entry.role),
          duplicateActiveRoles,
          staleCount: 0,
          malformedCount: 0,
          warnings: [],
        },
      }),
      doctorReport: doctorReport({
        checks: [
          runtimeStateLivenessCheck({
            counts: { total: 60, active: 60, stale: 0, malformed: 0 },
            duplicateActiveRoleSummaries: duplicateActiveRoles,
            records: [],
            malformed: [],
          }),
        ],
        warnings: [],
      }),
      generatedAt,
    }) as DashboardModel & { runtimeProcesses?: RuntimeProcessesPanel };

    expect(report.runtimeProcesses?.duplicateActiveRoles).toHaveLength(24);
    expect(report.runtimeProcesses?.duplicateActiveRoles[0]?.records).toHaveLength(12);
    expect(report.runtimeProcesses?.duplicateActiveRoles.some((entry) => entry.role === 'role-29')).toBe(false);
    expect(report.runtimeProcesses?.warnings ?? []).toEqual(expect.arrayContaining([
      expect.stringMatching(/Duplicate active role summaries were truncated to 24 roles/i),
      expect.stringMatching(/Duplicate active role records were truncated to 12 records per role/i),
    ]));
  });

  it('preserves detailed runtime-state.process-liveness record fields from doctor evidence', () => {
    const report = buildByomemDashboardModel({
      statusReport: statusReport({
        mcpProcesses: {
          source: 'runtime-state',
          count: 2,
          roles: ['memory'],
          duplicateActiveRoles: [
            {
              role: 'memory',
              count: 2,
              records: [
                {
                  pid: 101,
                  serverName: 'byomem-mcp-memory',
                  entrypoint: 'mcp-memory',
                  path: `${runtimeBaseDir}/runtime-state/processes/memory-101-a.json`,
                },
                {
                  pid: 202,
                  serverName: 'byomem-mcp-memory',
                  entrypoint: 'mcp-memory',
                  path: `${runtimeBaseDir}/runtime-state/processes/memory-202-b.json`,
                },
              ],
            },
          ],
          staleCount: 1,
          malformedCount: 1,
          warnings: [runtimeStateWarning],
        },
        warnings: [runtimeStateWarning],
      }),
      doctorReport: doctorReport({
        checks: [
          check({
            id: 'runtime-state.process-liveness',
            component: 'runtime-state',
            status: 'warn',
            severity: 'medium',
            title: 'Runtime process records have consistent liveness evidence',
            evidenceConfidence: 'constrained',
            evidence: {
              counts: { total: 2, active: 1, stale: 1, malformed: 1 },
              duplicateActiveRoles: ['memory'],
              duplicateActiveRoleSummaries: [
                {
                  role: 'memory',
                  count: 2,
                  records: [
                    {
                      pid: 101,
                      serverName: 'byomem-mcp-memory',
                      entrypoint: 'mcp-memory',
                      path: `${runtimeBaseDir}/runtime-state/processes/memory-101-a.json`,
                    },
                    {
                      pid: 202,
                      serverName: 'byomem-mcp-memory',
                      entrypoint: 'mcp-memory',
                      path: `${runtimeBaseDir}/runtime-state/processes/memory-202-b.json`,
                    },
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
                  runtimeVersion: BYOMEM_RUNTIME_VERSION,
                  startedAt: '2026-05-31T00:00:01.000Z',
                  lastHeartbeatAt: '2026-05-31T00:10:01.000Z',
                  state: 'active',
                  staleReason: null,
                  path: `${runtimeBaseDir}/runtime-state/processes/memory-101-a.json`,
                },
                {
                  role: 'memory',
                  serverName: 'byomem-mcp-memory',
                  pid: 202,
                  ppid: 1,
                  entrypoint: 'mcp-memory',
                  runtimeVersion: BYOMEM_RUNTIME_VERSION,
                  startedAt: '2026-05-31T00:00:02.000Z',
                  lastHeartbeatAt: '2026-05-31T00:10:02.000Z',
                  state: 'stale',
                  staleReason: 'pid-not-running',
                  path: `${runtimeBaseDir}/runtime-state/processes/memory-202-b.json`,
                },
              ],
              malformed: [
                {
                  path: `${runtimeBaseDir}/runtime-state/processes/malformed-00.json`,
                  error: 'Malformed runtime process JSON 0',
                },
              ],
            },
            warnings: [livenessWarning],
            suggestedActions: [action('Inspect runtime status', `byomem-runtime status --base-dir ${runtimeBaseDir}`)],
            skippedReason: null,
          }),
        ],
        warnings: [runtimeStateWarning, livenessWarning],
      }),
      generatedAt,
    }) as DashboardModel & { runtimeProcesses?: RuntimeProcessesPanel };

    expect(report).toHaveProperty('runtimeProcesses');
    expect(report.runtimeProcesses).toEqual(
      expect.objectContaining({
        evidenceConfidence: 'constrained',
        counts: expect.objectContaining({
          total: 2,
          active: 1,
          stale: 1,
          malformed: 1,
        }),
        records: expect.arrayContaining([
          expect.objectContaining({
            role: 'memory',
            serverName: 'byomem-mcp-memory',
            pid: 101,
            ppid: 1,
            entrypoint: 'mcp-memory',
            runtimeVersion: BYOMEM_RUNTIME_VERSION,
            startedAt: '2026-05-31T00:00:01.000Z',
            lastHeartbeatAt: '2026-05-31T00:10:01.000Z',
            state: 'active',
            staleReason: null,
            path: `${runtimeBaseDir}/runtime-state/processes/memory-101-a.json`,
          }),
          expect.objectContaining({
            role: 'memory',
            serverName: 'byomem-mcp-memory',
            pid: 202,
            ppid: 1,
            entrypoint: 'mcp-memory',
            runtimeVersion: BYOMEM_RUNTIME_VERSION,
            startedAt: '2026-05-31T00:00:02.000Z',
            lastHeartbeatAt: '2026-05-31T00:10:02.000Z',
            state: 'stale',
            staleReason: 'pid-not-running',
            path: `${runtimeBaseDir}/runtime-state/processes/memory-202-b.json`,
          }),
        ]),
        malformed: expect.arrayContaining([
          expect.objectContaining({
            path: `${runtimeBaseDir}/runtime-state/processes/malformed-00.json`,
            error: 'Malformed runtime process JSON 0',
          }),
        ]),
      }),
    );
  });
});
