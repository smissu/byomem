import { describe, expect, it } from 'vitest';
import type { DoctorCheck, DoctorReport, DoctorSuggestedAction } from '../src/doctor.js';
import type { StatusArtifactFile, StatusReport } from '../src/status-report.js';
import { BYOMEM_RUNTIME_VERSION } from '../src/version.js';
import { buildByomemDashboardModel } from '../src/dashboard.js';

const generatedAt = '2026-05-31T00:00:00.000Z';
const projectBaseDir = '/repo';
const runtimeBaseDir = '/runtime';
const runtimeStateWarning = 'Runtime process inventory is stale and needs review.';
const activeMcpNotCollectedReason = 'Active MCP runtime-info verification belongs to later health/verification work.';

function action(label: string, command: string): DoctorSuggestedAction {
  return { label, command, mode: 'read-only' };
}

function artifactFile(path: string, exists: boolean): StatusArtifactFile {
  return {
    path,
    exists,
    sizeBytes: exists ? 42 : null,
    mtimeMs: exists ? 1717113600000 : null,
    mtime: exists ? '2026-05-31T00:00:00.000Z' : null,
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
      memory: {
        json: memoryJson.path,
        sqlite: memorySqlite.path,
      },
      fileSearch: {
        sqlite: fileSearchSqlite.path,
      },
      graph: {
        sqlite: graphSqlite.path,
      },
    },
    artifacts: {
      memory: {
        status: 'ready',
        warnings: [],
        json: memoryJson,
        sqlite: memorySqlite,
      },
      fileSearch: {
        status: 'ready',
        warnings: [],
        sqlite: fileSearchSqlite,
      },
      graph: {
        status: 'ready',
        warnings: [],
        sqlite: graphSqlite,
      },
    },
    warnings: [],
    degradedComponents: [],
    mcpProcesses: {
      source: 'runtime-state',
      count: 0,
      roles: [],
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
        id: 'memory.artifacts',
        component: 'memory',
        status: 'pass',
        severity: 'info',
        title: 'Memory artifacts are present',
        evidence: {
          json: artifactFile(`${runtimeBaseDir}/native-store.json`, true),
          sqlite: artifactFile(`${runtimeBaseDir}/byomem-index.sqlite`, true),
        },
      }),
      check({
        id: 'file-search.artifacts',
        component: 'file-search',
        status: 'pass',
        severity: 'info',
        title: 'File-search artifacts are present',
        evidence: {
          sqlite: artifactFile(`${runtimeBaseDir}/byomem-file-search.sqlite`, true),
        },
      }),
      check({
        id: 'graph.artifacts',
        component: 'graph',
        status: 'pass',
        severity: 'info',
        title: 'Graph artifacts are present',
        evidence: {
          sqlite: artifactFile(`${runtimeBaseDir}/byomem-graph.sqlite`, true),
        },
      }),
      check({
        id: 'codex.config-presence',
        component: 'codex-config',
        status: 'pass',
        severity: 'info',
        title: 'Codex config includes BYOMem wiring',
        evidence: {
          path: '/Users/ericsmith/.codex/config.toml',
          exists: true,
          mentionsByomem: true,
        },
      }),
      check({
        id: 'runtime-state.inventory',
        component: 'runtime-state',
        status: 'pass',
        severity: 'info',
        title: 'Runtime process inventory is readable',
        evidence: {
          counts: { total: 0, active: 0, stale: 0, malformed: 0 },
        },
      }),
      check({
        id: 'runtime-state.process-liveness',
        component: 'runtime-state',
        status: 'pass',
        severity: 'info',
        title: 'Runtime process records have consistent liveness evidence',
        evidenceConfidence: 'constrained',
        evidence: {
          counts: { total: 0, active: 0, stale: 0, malformed: 0 },
        },
      }),
      check({
        id: 'file-search.embedding-health',
        component: 'file-search',
        status: 'skipped',
        severity: 'info',
        title: 'File-search embedding health is available through explicit scanner status',
        evidenceConfidence: 'not-applicable',
        evidence: {
          reason: 'Doctor does not open the file-search database or call an embedding provider.',
        },
        skippedReason: 'No read-only embedding diagnostic reader is available without opening file-search storage.',
        suggestedActions: [action('Inspect file-search status', 'byomem-runtime file-search-status --base-dir /repo --json')],
      }),
      check({
        id: 'runtime-info.active-mcp',
        component: 'runtime-info',
        status: 'skipped',
        severity: 'info',
        title: 'Active MCP runtime-info verification is deferred',
        evidenceConfidence: 'not-applicable',
        evidence: {
          reason: activeMcpNotCollectedReason,
        },
        skippedReason: activeMcpNotCollectedReason,
      }),
      check({
        id: 'doctor.read-only-boundary',
        component: 'doctor',
        status: 'pass',
        severity: 'info',
        title: 'Doctor command is read-only',
        evidence: {
          disallowedFlags: ['--apply'],
        },
      }),
    ],
    warnings: [runtimeStateWarning],
    suggestedActions: [
      action('Inspect status', 'byomem-runtime status --base-dir /runtime'),
      action('Inspect file-search status', 'byomem-runtime file-search-status --base-dir /repo --json'),
    ],
    ...overrides,
  };
}

describe('sprint 88 dashboard model contract', () => {
  it('builds a versioned dashboard model from injected status and doctor reports', () => {
    const report = buildByomemDashboardModel({
      statusReport: statusReport({
        artifacts: {
          memory: {
            status: 'degraded',
            warnings: ['Memory sqlite is missing while native-store.json remains present.'],
            json: artifactFile(`${runtimeBaseDir}/native-store.json`, true),
            sqlite: artifactFile(`${runtimeBaseDir}/byomem-index.sqlite`, false),
          },
          fileSearch: {
            status: 'missing',
            warnings: ['File-search SQLite artifact is missing.'],
            sqlite: artifactFile(`${runtimeBaseDir}/byomem-file-search.sqlite`, false),
          },
          graph: {
            status: 'missing',
            warnings: ['Graph SQLite artifact is missing.'],
            sqlite: artifactFile(`${runtimeBaseDir}/byomem-graph.sqlite`, false),
          },
        },
        warnings: [
          'Memory sqlite is missing while native-store.json remains present.',
          'File-search SQLite artifact is missing.',
          'Graph SQLite artifact is missing.',
          runtimeStateWarning,
        ],
        degradedComponents: ['memory', 'fileSearch', 'graph'],
        mcpProcesses: {
          source: 'runtime-state',
          count: 2,
          roles: ['memory', 'file-search'],
          staleCount: 1,
          malformedCount: 1,
          warnings: [runtimeStateWarning],
        },
      }),
      doctorReport: doctorReport({
        overallStatus: 'pass',
        warnings: [runtimeStateWarning],
      }),
      generatedAt,
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      command: 'dashboard',
      runtimeVersion: BYOMEM_RUNTIME_VERSION,
      generatedAt,
      projectBaseDir,
      runtimeBaseDir,
      paths: {
        projectBaseDir,
        runtimeBaseDir,
      },
      overallStatus: 'warn',
    });
    expect(report.statusComponents).toHaveLength(5);
    expect(report.statusComponents).toEqual([
      expect.objectContaining({
        id: 'memory',
        status: 'degraded',
        evidenceTier: 'stat-only',
      }),
      expect.objectContaining({
        id: 'file-search',
        status: 'missing',
        evidenceTier: 'stat-only',
      }),
      expect.objectContaining({
        id: 'graph',
        status: 'missing',
        evidenceTier: 'stat-only',
      }),
      expect.objectContaining({
        id: 'runtime-state',
        status: 'degraded',
        evidenceTier: 'stat-only',
      }),
      expect.objectContaining({
        id: 'codex-config',
        status: 'ready',
        evidenceTier: 'stat-only',
      }),
    ]);
    expect(report.degradedComponents).toEqual(['memory', 'file-search', 'graph', 'runtime-state']);
    expect(report.doctorChecks.map((check: { id: string }) => check.id)).toEqual([
      'version.runtime-alignment',
      'memory.artifacts',
      'file-search.artifacts',
      'graph.artifacts',
      'codex.config-presence',
      'runtime-state.inventory',
      'runtime-state.process-liveness',
      'file-search.embedding-health',
      'runtime-info.active-mcp',
      'doctor.read-only-boundary',
    ]);
    expect(report.doctorChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'file-search.embedding-health',
          status: 'skipped',
          evidenceConfidence: 'not-applicable',
          skippedReason: 'No read-only embedding diagnostic reader is available without opening file-search storage.',
        }),
        expect.objectContaining({
          id: 'runtime-info.active-mcp',
          status: 'skipped',
          evidenceTier: 'not-collected',
          evidenceConfidence: 'not-applicable',
          skippedReason: activeMcpNotCollectedReason,
        }),
      ]),
    );
    expect(report.warnings).toEqual(expect.arrayContaining([runtimeStateWarning]));
    expect(report.suggestedActions.every((suggestedAction: DoctorSuggestedAction) => suggestedAction.mode === 'read-only')).toBe(true);
    expect(report.statusComponents.length).toBeLessThanOrEqual(8);
  });

  it('promotes doctor failures over healthy status components', () => {
    const failingProcessLivenessCheck = check({
      id: 'runtime-state.process-liveness',
      component: 'runtime-state',
      status: 'fail',
      severity: 'high',
      title: 'Runtime process records have inconsistent liveness evidence',
      evidenceConfidence: 'definite',
      evidence: { counts: { total: 1, active: 0, stale: 1, malformed: 0 } },
      warnings: ['Runtime process inventory contains a stale PID that no longer exists.'],
      suggestedActions: [action('Inspect runtime status', 'byomem-runtime status --base-dir /runtime')],
      skippedReason: null,
    });
    const checks = doctorReport()
      .checks
      .filter((checkEntry) => checkEntry.id !== 'runtime-info.active-mcp' && checkEntry.id !== 'runtime-state.process-liveness')
      .concat(failingProcessLivenessCheck);

    const report = buildByomemDashboardModel({
      statusReport: statusReport(),
      doctorReport: doctorReport({
        overallStatus: 'pass',
        checks,
        warnings: ['Runtime process inventory contains a stale PID that no longer exists.'],
      }),
      generatedAt,
    });

    expect(report.overallStatus).toBe('fail');
    expect(report.degradedComponents).toEqual([]);
    expect(report.statusComponents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'memory', status: 'ready' }),
        expect.objectContaining({ id: 'file-search', status: 'ready' }),
        expect.objectContaining({ id: 'graph', status: 'ready' }),
        expect.objectContaining({ id: 'runtime-state', status: 'ready' }),
        expect.objectContaining({ id: 'codex-config', status: 'ready' }),
      ]),
    );
    expect(report.doctorChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'runtime-state.process-liveness',
          status: 'fail',
          evidenceConfidence: 'definite',
        }),
      ]),
    );
  });

  it('bounds dashboard arrays and represents overflow with warnings', () => {
    const overflowChecks = Array.from({ length: 40 }, (_, index) =>
      check({
        id: `overflow.check-${String(index).padStart(2, '0')}`,
        component: 'doctor',
        status: 'pass',
        severity: 'info',
        title: `Overflow check ${index}`,
        evidence: { index },
        warnings: [`Overflow warning ${index}`],
        suggestedActions: [
          action(`Inspect overflow check ${index}`, `echo overflow-${index}`),
          action(`Inspect overflow detail ${index}`, `echo overflow-detail-${index}`),
        ],
      }),
    );

    const report = buildByomemDashboardModel({
      statusReport: statusReport({
        warnings: Array.from({ length: 12 }, (_, index) => `Status warning ${index}`),
      }),
      doctorReport: doctorReport({
        checks: overflowChecks,
        warnings: Array.from({ length: 18 }, (_, index) => `Doctor warning ${index}`),
        suggestedActions: Array.from({ length: 18 }, (_, index) =>
          action(`Doctor action ${index}`, `echo doctor-action-${index}`),
        ),
      }),
      generatedAt,
    });

    expect(report.statusComponents.length).toBeLessThanOrEqual(8);
    expect(report.doctorChecks.length).toBeLessThanOrEqual(32);
    expect(report.warnings.length).toBeLessThanOrEqual(20);
    expect(report.suggestedActions.length).toBeLessThanOrEqual(20);
    expect(report.warnings.some((warning: string) => /overflow|truncat|additional/i.test(warning))).toBe(true);
  });
});
