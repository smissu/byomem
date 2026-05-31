import { describe, expect, it } from 'vitest';
import type { DoctorCheck, DoctorReport, DoctorSuggestedAction } from '../src/doctor.js';
import type { StatusArtifactFile, StatusReport } from '../src/status-report.js';
import { BYOMEM_RUNTIME_VERSION } from '../src/version.js';
import { buildByomemDashboardModel } from '../src/dashboard.js';

const generatedAt = '2026-05-31T00:00:00.000Z';
const projectBaseDir = '/repo';
const runtimeBaseDir = '/runtime';
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
      check({ id: 'version.runtime-alignment', component: 'version', status: 'pass', severity: 'info', title: 'Runtime version files are aligned' }),
      check({ id: 'memory.artifacts', component: 'memory', status: 'pass', severity: 'info', title: 'Memory artifacts are present' }),
      check({ id: 'file-search.artifacts', component: 'file-search', status: 'pass', severity: 'info', title: 'File-search artifacts are present' }),
      check({ id: 'graph.artifacts', component: 'graph', status: 'pass', severity: 'info', title: 'Graph artifacts are present' }),
      check({ id: 'codex.config-presence', component: 'codex-config', status: 'pass', severity: 'info', title: 'Codex config includes BYOMem wiring' }),
      check({ id: 'runtime-state.inventory', component: 'runtime-state', status: 'pass', severity: 'info', title: 'Runtime process inventory is readable' }),
      check({
        id: 'runtime-info.active-mcp',
        component: 'runtime-info',
        status: 'skipped',
        severity: 'info',
        title: 'Active MCP runtime-info verification is deferred',
        evidenceConfidence: 'not-applicable',
        evidence: { reason: activeMcpNotCollectedReason },
        skippedReason: activeMcpNotCollectedReason,
      }),
    ],
    warnings: [],
    suggestedActions: [
      action('Inspect status', 'byomem-runtime status --base-dir /runtime'),
      action('Inspect doctor', 'byomem-runtime doctor --base-dir /runtime --json'),
    ],
    ...overrides,
  };
}

describe('sprint 92 dashboard model RED contract', () => {
  it('exposes identity metadata, KPI cards, capability banners, first-run guidance, section summaries, and command cards', () => {
    const report = buildByomemDashboardModel({
      statusReport: statusReport({
        artifacts: {
          memory: { status: 'missing', warnings: ['Memory artifacts missing on first run.'], json: artifactFile(`${runtimeBaseDir}/native-store.json`, false), sqlite: artifactFile(`${runtimeBaseDir}/byomem-index.sqlite`, false) },
          fileSearch: { status: 'missing', warnings: ['File-search artifacts missing on first run.'], sqlite: artifactFile(`${runtimeBaseDir}/byomem-file-search.sqlite`, false) },
          graph: { status: 'missing', warnings: ['Graph artifacts missing on first run.'], sqlite: artifactFile(`${runtimeBaseDir}/byomem-graph.sqlite`, false) },
        },
      }),
      doctorReport: doctorReport(),
      generatedAt,
    }) as unknown as Record<string, unknown>;

    expect(report.identityMeta).toEqual(
      expect.objectContaining({
        runtimeVersion: BYOMEM_RUNTIME_VERSION,
        projectBaseDir,
        runtimeBaseDir,
        generatedAt,
        overallStatus: expect.stringMatching(/^(pass|warn|fail)$/),
      }),
    );
    expect(report.kpiCards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'status-components' }),
        expect.objectContaining({ id: 'doctor-checks' }),
        expect.objectContaining({ id: 'warnings' }),
      ]),
    );
    expect(report.capabilityBanners).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'active-mcp-runtime-info', evidenceTier: 'not-collected' }),
      ]),
    );
    expect(report.firstRunGuidance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'create-initial-artifacts',
          mode: 'read-only',
          command: expect.stringContaining('byomem-runtime status'),
        }),
      ]),
    );
    expect(report.sectionSummaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'memory' }),
        expect.objectContaining({ id: 'file-search' }),
        expect.objectContaining({ id: 'graph' }),
        expect.objectContaining({ id: 'runtime-state' }),
        expect.objectContaining({ id: 'codex-config' }),
      ]),
    );
    expect(report.commandCards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'status', mode: 'read-only' }),
        expect.objectContaining({ id: 'doctor', mode: 'read-only' }),
      ]),
    );
  });

  it('keeps sprint 92 arrays bounded', () => {
    const overflowChecks = Array.from({ length: 50 }, (_, index) =>
      check({
        id: `overflow.check-${index}`,
        component: 'doctor',
        status: 'pass',
        severity: 'info',
        title: `Overflow check ${index}`,
        warnings: [`Overflow warning ${index}`],
        suggestedActions: [action(`Overflow action ${index}`, `echo overflow-${index}`)],
      }),
    );
    const report = buildByomemDashboardModel({
      statusReport: statusReport({ warnings: Array.from({ length: 40 }, (_, index) => `Status warning ${index}`) }),
      doctorReport: doctorReport({ checks: overflowChecks, warnings: Array.from({ length: 40 }, (_, index) => `Doctor warning ${index}`) }),
      generatedAt,
    }) as unknown as {
      kpiCards?: unknown[];
      capabilityBanners?: unknown[];
      firstRunGuidance?: unknown[];
      sectionSummaries?: unknown[];
      commandCards?: unknown[];
      warnings?: string[];
    };

    expect(report.kpiCards?.length ?? 0).toBeLessThanOrEqual(8);
    expect(report.capabilityBanners?.length ?? 0).toBeLessThanOrEqual(8);
    expect(report.firstRunGuidance?.length ?? 0).toBeLessThanOrEqual(8);
    expect(report.sectionSummaries?.length ?? 0).toBeLessThanOrEqual(10);
    expect(report.commandCards?.length ?? 0).toBeLessThanOrEqual(12);
    expect((report.warnings ?? []).some((warning) => /truncat|bounded|omitted/i.test(warning))).toBe(true);
  });

  it('marks active MCP runtime-info as not-collected unless explicitly injected', () => {
    const defaultReport = buildByomemDashboardModel({
      statusReport: statusReport(),
      doctorReport: doctorReport(),
      generatedAt,
    }) as unknown as { capabilityBanners?: Array<{ id: string; evidenceTier?: string; state?: string }> };

    expect(defaultReport.capabilityBanners).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'active-mcp-runtime-info', evidenceTier: 'not-collected' }),
      ]),
    );

    const injectedReport = buildByomemDashboardModel({
      statusReport: statusReport(),
      doctorReport: doctorReport(),
      generatedAt,
      activeMcpRuntimeInfo: {
        server: 'byomem-runtime',
        collectedAt: generatedAt,
        status: 'connected',
      },
    } as never) as unknown as { capabilityBanners?: Array<{ id: string; evidenceTier?: string; state?: string }> };

    expect(injectedReport.capabilityBanners).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'active-mcp-runtime-info', evidenceTier: 'active-mcp-runtime-info', state: 'connected' }),
      ]),
    );
  });
});
