import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildByomemStatusReport, type StatusComponentState } from './status-report.js';
import { readRuntimeProcessInventory, summarizeDuplicateActiveRuntimeProcessRoles, type RuntimeProcessInventoryOptions } from './runtime-state.js';
import { BYOMEM_RUNTIME_VERSION } from './version.js';

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail' | 'skipped';
export type DoctorOverallStatus = 'pass' | 'warn' | 'fail';
export type DoctorSeverity = 'info' | 'low' | 'medium' | 'high';
export type DoctorEvidenceConfidence = 'definite' | 'constrained' | 'not-applicable';

export type DoctorSuggestedAction = {
  label: string;
  command: string;
  mode: 'read-only';
};

export type DoctorCheck = {
  id: string;
  component: string;
  status: DoctorCheckStatus;
  severity: DoctorSeverity;
  title: string;
  evidenceConfidence: DoctorEvidenceConfidence;
  evidence: Record<string, unknown>;
  warnings: string[];
  suggestedActions: DoctorSuggestedAction[];
  skippedReason: string | null;
};

export type DoctorReport = {
  command: 'doctor';
  version: string;
  runtimeVersion: string;
  generatedAt: string;
  projectBaseDir: string;
  runtimeBaseDir: string;
  overallStatus: DoctorOverallStatus;
  checks: DoctorCheck[];
  warnings: string[];
  suggestedActions: DoctorSuggestedAction[];
};

export type BuildDoctorReportOptions = RuntimeProcessInventoryOptions & {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  projectBaseDir?: string;
  generatedAt?: Date | string;
  processEvidenceConfidence?: DoctorEvidenceConfidence;
  codexConfigPath?: string;
  versionBaseDir?: string;
};

function dedupe<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function dedupeActions(values: DoctorSuggestedAction[]): DoctorSuggestedAction[] {
  return [...new Map(values.map((entry) => [entry.command, entry])).values()];
}

function action(label: string, command: string): DoctorSuggestedAction {
  return { label, command, mode: 'read-only' };
}

function statusToCheckStatus(status: StatusComponentState): DoctorCheckStatus {
  if (status === 'ready') return 'pass';
  if (status === 'degraded') return 'warn';
  return 'warn';
}

function artifactCheck(
  id: string,
  component: string,
  title: string,
  status: StatusComponentState,
  evidence: Record<string, unknown>,
  warnings: string[],
  suggestedActions: DoctorSuggestedAction[],
): DoctorCheck {
  const checkStatus = statusToCheckStatus(status);
  return {
    id,
    component,
    title,
    status: checkStatus,
    severity: checkStatus === 'pass' ? 'info' : 'medium',
    evidenceConfidence: 'definite',
    evidence,
    warnings,
    suggestedActions,
    skippedReason: null,
  };
}

function readPackageVersion(path: string): { path: string; exists: boolean; version: string | null; error?: string } {
  if (!existsSync(path)) return { path, exists: false, version: null };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown };
    return {
      path,
      exists: true,
      version: typeof parsed.version === 'string' ? parsed.version : null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { path, exists: true, version: null, error: message };
  }
}

function versionAlignmentCheck(baseDir: string, statusRuntimeVersion: string): DoctorCheck {
  const versionFiles = [
    readPackageVersion(join(baseDir, 'package.json')),
    readPackageVersion(join(baseDir, 'package-lock.json')),
    readPackageVersion(join(baseDir, 'ts/packages/runtime/package.json')),
  ];
  const present = versionFiles.filter((entry) => entry.exists);
  const mismatches = present.filter((entry) => entry.version !== BYOMEM_RUNTIME_VERSION);
  const errors = present.filter((entry) => entry.error);
  const runtimeMismatch = statusRuntimeVersion !== BYOMEM_RUNTIME_VERSION;
  const skipped = present.length === 0;
  const failed = runtimeMismatch || mismatches.length > 0 || errors.length > 0;
  const checkStatus: DoctorCheckStatus = skipped ? 'skipped' : failed ? 'fail' : 'pass';

  return {
    id: 'version.runtime-alignment',
    component: 'version',
    status: checkStatus,
    severity: failed ? 'high' : 'info',
    title: 'Runtime version files are aligned',
    evidenceConfidence: 'definite',
    evidence: {
      versionBaseDir: baseDir,
      statusRuntimeVersion,
      runtimeVersionConstant: BYOMEM_RUNTIME_VERSION,
      files: versionFiles,
    },
    warnings: [
      ...(runtimeMismatch ? ['Status report runtime version does not match the runtime version constant.'] : []),
      ...mismatches.map((entry) => `${entry.path} version ${entry.version ?? '<missing>'} does not match ${BYOMEM_RUNTIME_VERSION}.`),
      ...errors.map((entry) => `${entry.path} could not be parsed: ${entry.error}`),
    ],
    suggestedActions: skipped ? [] : [action('Inspect version files', `grep -n '"version"' ${join(baseDir, 'package.json')} ${join(baseDir, 'ts/packages/runtime/package.json')} ${join(baseDir, 'package-lock.json')}`)],
    skippedReason: skipped ? 'No package version files were found under the version base directory.' : null,
  };
}

function configCheck(path: string): DoctorCheck {
  if (!existsSync(path)) {
    return {
      id: 'codex.config-presence',
      component: 'codex-config',
      status: 'skipped',
      severity: 'info',
      title: 'Codex config file is available for BYOMem wiring checks',
      evidenceConfidence: 'definite',
      evidence: { path, exists: false },
      warnings: [],
      suggestedActions: [],
      skippedReason: 'Codex config file was not present at the default path.',
    };
  }

  try {
    const text = readFileSync(path, 'utf8');
    const mentionsByomem = text.includes('byomem');
    const status: DoctorCheckStatus = mentionsByomem ? 'pass' : 'warn';
    return {
      id: 'codex.config-presence',
      component: 'codex-config',
      status,
      severity: status === 'pass' ? 'info' : 'low',
      title: 'Codex config includes BYOMem wiring',
      evidenceConfidence: 'definite',
      evidence: { path, exists: true, mentionsByomem },
      warnings: mentionsByomem ? [] : ['Codex config exists but does not mention byomem.'],
      suggestedActions: mentionsByomem ? [] : [action('Inspect Codex MCP config', `sed -n '1,220p' ${path}`)],
      skippedReason: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      id: 'codex.config-presence',
      component: 'codex-config',
      status: 'warn',
      severity: 'low',
      title: 'Codex config could not be read for BYOMem wiring checks',
      evidenceConfidence: 'definite',
      evidence: { path, exists: true, error: message },
      warnings: [`Codex config could not be read: ${message}`],
      suggestedActions: [],
      skippedReason: null,
    };
  }
}

function runtimeStateChecks(options: BuildDoctorReportOptions): DoctorCheck[] {
  const runtimeBaseDir = resolve(options.runtimeBaseDir);
  const evidenceConfidence = options.processEvidenceConfidence ?? (options.processExists ? 'definite' : 'definite');
  const inventory = readRuntimeProcessInventory({
    runtimeBaseDir,
    now: options.now,
    staleAfterMs: options.staleAfterMs,
    processExists: options.processExists,
  });
  const duplicateActiveRoleSummaries = summarizeDuplicateActiveRuntimeProcessRoles(inventory);
  const duplicateActiveRoles = duplicateActiveRoleSummaries.map((entry) => entry.role);

  const warnings = [
    ...inventory.warnings,
    ...(inventory.counts.stale > 0 ? [`${inventory.counts.stale} stale runtime process record(s) found.`] : []),
    ...(duplicateActiveRoles.length ? [`Duplicate active MCP roles found: ${duplicateActiveRoles.join(', ')}`] : []),
    ...(evidenceConfidence === 'constrained' && inventory.counts.stale > 0 ? ['PID liveness evidence is constrained; stale records require isolated confirmation before cleanup.'] : []),
  ];
  const status: DoctorCheckStatus = warnings.length ? 'warn' : 'pass';

  return [
    {
      id: 'runtime-state.inventory',
      component: 'runtime-state',
      status: inventory.warnings.length && inventory.counts.total === 0 ? 'warn' : 'pass',
      severity: inventory.warnings.length && inventory.counts.total === 0 ? 'low' : 'info',
      title: 'Runtime process inventory is readable',
      evidenceConfidence: 'definite',
      evidence: {
        stateDir: inventory.stateDir,
        counts: inventory.counts,
      },
      warnings: inventory.warnings,
      suggestedActions: [action('Inspect runtime status', `byomem-runtime status --base-dir ${runtimeBaseDir}`)],
      skippedReason: null,
    },
    {
      id: 'runtime-state.process-liveness',
      component: 'runtime-state',
      status,
      severity: status === 'pass' ? 'info' : 'medium',
      title: 'Runtime process records have consistent liveness evidence',
      evidenceConfidence,
      evidence: {
        stateDir: inventory.stateDir,
        counts: inventory.counts,
        duplicateActiveRoles,
        duplicateActiveRoleSummaries,
        records: inventory.records.map((entry) => ({
          role: entry.record.role,
          serverName: entry.record.serverName,
          pid: entry.record.pid,
          ppid: entry.record.ppid,
          entrypoint: entry.record.entrypoint,
          runtimeVersion: entry.record.runtimeVersion,
          startedAt: entry.record.startedAt,
          lastHeartbeatAt: entry.record.lastHeartbeatAt,
          identity: entry.record.identity ?? null,
          state: entry.state,
          staleReason: entry.staleReason ?? null,
          path: entry.path,
        })),
        malformed: inventory.malformed,
      },
      warnings,
      suggestedActions: [
        action('Inspect cleanup dry-run', `byomem-runtime cleanup --base-dir ${runtimeBaseDir}`),
        action('Inspect stop dry-run', `byomem-runtime stop --base-dir ${runtimeBaseDir}`),
      ],
      skippedReason: null,
    },
  ];
}

function embeddingCheck(): DoctorCheck {
  return {
    id: 'file-search.embedding-health',
    component: 'file-search',
    status: 'skipped',
    severity: 'info',
    title: 'File-search embedding health is available through explicit scanner status',
    evidenceConfidence: 'not-applicable',
    evidence: {
      reason: 'Doctor does not open the file-search database or call an embedding provider.',
    },
    warnings: [],
    suggestedActions: [action('Inspect file-search status', 'byomem-runtime file-search-status --base-dir <project> --json')],
    skippedReason: 'No read-only embedding diagnostic reader is available without opening file-search storage.',
  };
}

function readOnlyBoundaryCheck(): DoctorCheck {
  return {
    id: 'doctor.read-only-boundary',
    component: 'doctor',
    status: 'pass',
    severity: 'info',
    title: 'Doctor command is read-only',
    evidenceConfidence: 'definite',
    evidence: {
      disallowedFlags: ['--apply'],
      mutationModes: [],
    },
    warnings: [],
    suggestedActions: [],
    skippedReason: null,
  };
}

function deriveOverallStatus(checks: DoctorCheck[]): DoctorOverallStatus {
  if (checks.some((check) => check.status === 'fail')) return 'fail';
  if (checks.some((check) => check.status === 'warn')) return 'warn';
  return 'pass';
}

export function buildByomemDoctorReport(options: BuildDoctorReportOptions): DoctorReport {
  const runtimeBaseDir = resolve(options.runtimeBaseDir);
  const status = buildByomemStatusReport({
    env: options.env,
    cwd: options.cwd,
    projectBaseDir: options.projectBaseDir,
    runtimeBaseDir,
    generatedAt: options.generatedAt,
    now: options.now,
    staleAfterMs: options.staleAfterMs,
    processExists: options.processExists,
  });
  const codexConfigPath = resolve(options.codexConfigPath ?? join(homedir(), '.codex', 'config.toml'));
  const versionBaseDir = resolve(options.versionBaseDir ?? status.projectBaseDir);
  const checks: DoctorCheck[] = [
    versionAlignmentCheck(versionBaseDir, status.runtimeVersion),
    artifactCheck(
      'memory.artifacts',
      'memory',
      'Memory artifacts are present',
      status.artifacts.memory.status,
      {
        json: status.artifacts.memory.json,
        sqlite: status.artifacts.memory.sqlite,
      },
      status.artifacts.memory.warnings,
      [action('Inspect status', `byomem-runtime status --base-dir ${runtimeBaseDir}`)],
    ),
    artifactCheck(
      'file-search.artifacts',
      'file-search',
      'File-search artifacts are present',
      status.artifacts.fileSearch.status,
      { sqlite: status.artifacts.fileSearch.sqlite },
      status.artifacts.fileSearch.warnings,
      [action('Run explicit file-search status', `byomem-runtime file-search-status --base-dir ${status.projectBaseDir} --json`)],
    ),
    artifactCheck(
      'graph.artifacts',
      'graph',
      'Graph artifacts are present',
      status.artifacts.graph.status,
      { sqlite: status.artifacts.graph.sqlite },
      status.artifacts.graph.warnings,
      [action('Inspect graph status', `byomem-runtime graph-status --base-dir ${status.projectBaseDir}`)],
    ),
    configCheck(codexConfigPath),
    ...runtimeStateChecks(options),
    embeddingCheck(),
    readOnlyBoundaryCheck(),
  ];
  const warnings = dedupe(checks.flatMap((check) => check.warnings));
  return {
    command: 'doctor',
    version: BYOMEM_RUNTIME_VERSION,
    runtimeVersion: BYOMEM_RUNTIME_VERSION,
    generatedAt: status.generatedAt,
    projectBaseDir: status.projectBaseDir,
    runtimeBaseDir,
    overallStatus: deriveOverallStatus(checks),
    checks,
    warnings,
    suggestedActions: dedupeActions(checks.flatMap((check) => check.suggestedActions)),
  };
}
