import { resolve } from 'node:path';
import { readRuntimeProcessInventory, type RuntimeProcessInventory, type RuntimeProcessInventoryOptions } from './runtime-state.js';

export type ProcessCleanupClassification =
  | 'active-owned'
  | 'stale-pid-missing'
  | 'stale-heartbeat-expired'
  | 'malformed-state';

export type ProcessCleanupCandidate = {
  source: 'runtime-state';
  classification: ProcessCleanupClassification;
  action: 'none';
  safeToTerminate: false;
  safeToRemoveState: false;
  reason: string;
  path: string;
  record?: {
    role: string;
    serverName: string;
    pid: number;
    ppid: number;
    entrypoint: string;
    cwd: string;
    runtimeVersion: string;
    startedAt: string;
    lastHeartbeatAt: string;
  };
  error?: string;
};

export type ProcessCleanupReport = {
  command: 'cleanup' | 'stop';
  dryRun: true;
  applySupported: false;
  generatedAt: string;
  runtimeBaseDir: string;
  stateDir: string;
  summary: {
    total: number;
    active: number;
    stale: number;
    malformed: number;
    wouldTerminate: 0;
    wouldRemoveState: 0;
  };
  candidates: ProcessCleanupCandidate[];
  warnings: string[];
};

export type BuildProcessCleanupReportOptions = Omit<RuntimeProcessInventoryOptions, 'runtimeBaseDir'> & {
  command?: 'cleanup' | 'stop';
  runtimeBaseDir: string;
  generatedAt?: Date | string;
};

function normalizeTimestamp(value?: Date | string): string {
  if (value === undefined) return new Date().toISOString();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new Error('generatedAt must be a valid date');
    return parsed.toISOString();
  }
  return value.toISOString();
}

function classifyInventory(inventory: RuntimeProcessInventory): ProcessCleanupCandidate[] {
  const recordCandidates = inventory.records.map((entry): ProcessCleanupCandidate => {
    const classification: ProcessCleanupClassification = entry.state === 'active'
      ? 'active-owned'
      : entry.staleReason === 'heartbeat-expired'
        ? 'stale-heartbeat-expired'
        : 'stale-pid-missing';
    const reason = entry.state === 'active'
      ? 'runtime-state record appears active; dry-run cleanup will not terminate active owned processes'
      : entry.staleReason === 'heartbeat-expired'
        ? 'runtime-state heartbeat is stale; dry-run only, no state removal or termination performed'
        : 'runtime-state pid is not running; dry-run only, no state removal performed';
    return {
      source: 'runtime-state',
      classification,
      action: 'none',
      safeToTerminate: false,
      safeToRemoveState: false,
      reason,
      path: entry.path,
      record: {
        role: entry.record.role,
        serverName: entry.record.serverName,
        pid: entry.record.pid,
        ppid: entry.record.ppid,
        entrypoint: entry.record.entrypoint,
        cwd: entry.record.cwd,
        runtimeVersion: entry.record.runtimeVersion,
        startedAt: entry.record.startedAt,
        lastHeartbeatAt: entry.record.lastHeartbeatAt,
      },
    };
  });
  const malformedCandidates = inventory.malformed.map((entry): ProcessCleanupCandidate => ({
    source: 'runtime-state',
    classification: 'malformed-state',
    action: 'none',
    safeToTerminate: false,
    safeToRemoveState: false,
    reason: 'runtime-state record is malformed; dry-run cleanup will not remove ambiguous state',
    path: entry.path,
    error: entry.error,
  }));
  return [...recordCandidates, ...malformedCandidates].sort((a, b) => a.path.localeCompare(b.path));
}

export function buildProcessCleanupReport(options: BuildProcessCleanupReportOptions): ProcessCleanupReport {
  const runtimeBaseDir = resolve(options.runtimeBaseDir);
  const inventory = readRuntimeProcessInventory({
    runtimeBaseDir,
    now: options.now,
    staleAfterMs: options.staleAfterMs,
    processExists: options.processExists,
  });
  const candidates = classifyInventory(inventory);
  return {
    command: options.command ?? 'cleanup',
    dryRun: true,
    applySupported: false,
    generatedAt: normalizeTimestamp(options.generatedAt),
    runtimeBaseDir,
    stateDir: inventory.stateDir,
    summary: {
      total: inventory.counts.total,
      active: inventory.counts.active,
      stale: inventory.counts.stale,
      malformed: inventory.counts.malformed,
      wouldTerminate: 0,
      wouldRemoveState: 0,
    },
    candidates,
    warnings: [
      ...inventory.warnings,
      'cleanup apply mode is intentionally disabled in this dry-run-only sprint',
    ],
  };
}

