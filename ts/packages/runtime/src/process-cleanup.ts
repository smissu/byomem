import { existsSync, rmSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { isCanonicalByomemMcpRuntimeProcess, readRuntimeProcessInventory, type RuntimeProcessInventory, type RuntimeProcessInventoryEntry, type RuntimeProcessInventoryOptions } from './runtime-state.js';

export type ProcessCleanupClassification =
  | 'active-owned'
  | 'stale-pid-missing'
  | 'stale-heartbeat-expired'
  | 'malformed-state';

export type ProcessCleanupCandidate = {
  source: 'runtime-state';
  classification: ProcessCleanupClassification;
  action: 'none' | 'would-remove-state' | 'remove-state' | 'preserve' | 'refuse' | 'failed';
  safeToTerminate: false;
  safeToRemoveState: boolean;
  reason: string;
  evidence:
    | 'active'
    | 'pid-missing'
    | 'heartbeat-expired'
    | 'malformed'
    | 'ownership-mismatch'
    | 'path-outside-state-dir'
    | 'race-became-active'
    | 'race-identity-changed'
    | 'race-file-missing'
    | 'delete-failed';
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
  reportVersion: 1;
  command: 'cleanup' | 'stop';
  dryRun: boolean;
  applySupported: boolean;
  applied: boolean;
  changed: boolean;
  generatedAt: string;
  runtimeBaseDir: string;
  stateDir: string;
  processStateDir: string;
  summary: {
    total: number;
    active: number;
    stale: number;
    malformed: number;
    wouldTerminate: number;
    wouldRemoveState: number;
    removedState: number;
    preserved: number;
    refused: number;
    failed: number;
  };
  candidates: ProcessCleanupCandidate[];
  warnings: string[];
};

export type BuildProcessCleanupReportOptions = Omit<RuntimeProcessInventoryOptions, 'runtimeBaseDir'> & {
  command?: 'cleanup' | 'stop';
  mode?: 'dry-run' | 'apply';
  runtimeBaseDir: string;
  generatedAt?: Date | string;
  beforeApplyCandidate?: (candidate: ProcessCleanupCandidate) => void;
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

function pathInsideStateDir(path: string, stateDir: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedStateDir = resolve(stateDir);
  const rel = relative(resolvedStateDir, resolvedPath);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && rel !== '..');
}

function hasNearMatchArgv(entry: RuntimeProcessInventoryEntry): boolean {
  return entry.record.argv.some((value) => value.endsWith('.bak'));
}

function isCleanupOwned(entry: RuntimeProcessInventoryEntry): boolean {
  return isCanonicalByomemMcpRuntimeProcess(entry.record) && !hasNearMatchArgv(entry);
}

function sameRuntimeRecord(a: RuntimeProcessInventoryEntry, b: RuntimeProcessInventoryEntry): boolean {
  return a.record.id === b.record.id
    && a.record.pid === b.record.pid
    && a.record.role === b.record.role
    && a.record.serverName === b.record.serverName
    && a.record.entrypoint === b.record.entrypoint
    && a.record.startedAt === b.record.startedAt;
}

function classifyInventory(inventory: RuntimeProcessInventory, mode: 'dry-run' | 'apply'): ProcessCleanupCandidate[] {
  const recordCandidates = inventory.records.map((entry): ProcessCleanupCandidate => {
    const classification: ProcessCleanupClassification = entry.state === 'active'
      ? 'active-owned'
      : entry.staleReason === 'heartbeat-expired'
        ? 'stale-heartbeat-expired'
        : 'stale-pid-missing';
    const owned = isCleanupOwned(entry);
    const safeToRemoveState = entry.state === 'stale' && entry.staleReason === 'pid-not-running' && owned && pathInsideStateDir(entry.path, inventory.stateDir);
    const action: ProcessCleanupCandidate['action'] = entry.state === 'active'
      ? 'none'
      : entry.staleReason === 'heartbeat-expired'
        ? 'preserve'
        : safeToRemoveState
          ? mode === 'apply' ? 'remove-state' : 'would-remove-state'
          : 'refuse';
    const reason = entry.state === 'active'
      ? 'runtime-state record appears active; cleanup will not terminate active owned processes'
      : entry.staleReason === 'heartbeat-expired'
        ? 'runtime-state heartbeat is stale but pid is running; state removal is not safe'
        : !pathInsideStateDir(entry.path, inventory.stateDir)
          ? 'runtime-state record path is outside the selected process state directory'
          : !owned
            ? 'runtime-state record is not confidently BYOMem-owned for cleanup'
            : mode === 'apply'
              ? 'runtime-state pid is not running; stale state record is eligible for removal'
              : 'runtime-state pid is not running; dry-run cleanup would remove stale state';
    const evidence: ProcessCleanupCandidate['evidence'] = entry.state === 'active'
      ? 'active'
      : entry.staleReason === 'heartbeat-expired'
        ? 'heartbeat-expired'
        : !pathInsideStateDir(entry.path, inventory.stateDir)
          ? 'path-outside-state-dir'
          : !owned
            ? 'ownership-mismatch'
            : 'pid-missing';
    return {
      source: 'runtime-state',
      classification,
      action,
      safeToTerminate: false,
      safeToRemoveState,
      reason,
      evidence,
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
    action: 'refuse',
    safeToTerminate: false,
    safeToRemoveState: false,
    reason: 'runtime-state record is malformed; cleanup will not remove ambiguous state',
    evidence: 'malformed',
    path: entry.path,
    error: entry.error,
  }));
  return [...recordCandidates, ...malformedCandidates].sort((a, b) => a.path.localeCompare(b.path));
}

function summarize(inventory: RuntimeProcessInventory, candidates: ProcessCleanupCandidate[]): ProcessCleanupReport['summary'] {
  return {
    total: inventory.counts.total,
    active: inventory.counts.active,
    stale: inventory.counts.stale,
    malformed: inventory.counts.malformed,
    wouldTerminate: 0,
    wouldRemoveState: candidates.filter((candidate) => candidate.action === 'would-remove-state').length,
    removedState: candidates.filter((candidate) => candidate.action === 'remove-state').length,
    preserved: candidates.filter((candidate) => candidate.action === 'preserve' || candidate.action === 'none').length,
    refused: candidates.filter((candidate) => candidate.action === 'refuse').length,
    failed: candidates.filter((candidate) => candidate.action === 'failed').length,
  };
}

function applyCandidate(options: BuildProcessCleanupReportOptions, stateDir: string, initial: RuntimeProcessInventoryEntry, candidate: ProcessCleanupCandidate): ProcessCleanupCandidate {
  options.beforeApplyCandidate?.(candidate);
  const runtimeBaseDir = resolve(options.runtimeBaseDir);
  const secondPass = readRuntimeProcessInventory({
    runtimeBaseDir,
    now: options.now,
    staleAfterMs: options.staleAfterMs,
    processExists: options.processExists,
  });
  const current = secondPass.records.find((entry) => entry.path === candidate.path);
  if (!current) {
    return { ...candidate, action: 'preserve', safeToRemoveState: false, evidence: 'race-file-missing', reason: 'runtime-state record disappeared before cleanup could remove it' };
  }
  if (!pathInsideStateDir(current.path, stateDir)) {
    return { ...candidate, action: 'refuse', safeToRemoveState: false, evidence: 'path-outside-state-dir', reason: 'runtime-state record path is outside the selected process state directory' };
  }
  if (current.state !== 'stale' || current.staleReason !== 'pid-not-running') {
    return { ...candidate, action: 'preserve', safeToRemoveState: false, evidence: 'race-became-active', reason: 'runtime-state record is no longer stale pid-missing on second pass' };
  }
  if (!sameRuntimeRecord(initial, current) || !isCleanupOwned(current)) {
    return { ...candidate, action: 'refuse', safeToRemoveState: false, evidence: 'race-identity-changed', reason: 'runtime-state record identity or ownership changed before cleanup could remove it' };
  }
  try {
    if (existsSync(current.path)) rmSync(current.path, { force: true });
    return { ...candidate, action: 'remove-state', safeToRemoveState: true, evidence: 'pid-missing', reason: 'removed stale BYOMem runtime-state record whose pid is not running' };
  } catch (error) {
    return {
      ...candidate,
      action: 'failed',
      safeToRemoveState: false,
      evidence: 'delete-failed',
      reason: 'failed to remove stale BYOMem runtime-state record',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildProcessCleanupReport(options: BuildProcessCleanupReportOptions): ProcessCleanupReport {
  const runtimeBaseDir = resolve(options.runtimeBaseDir);
  const mode = options.mode ?? 'dry-run';
  const inventory = readRuntimeProcessInventory({
    runtimeBaseDir,
    now: options.now,
    staleAfterMs: options.staleAfterMs,
    processExists: options.processExists,
  });
  const plannedCandidates = classifyInventory(inventory, mode);
  const candidates = mode === 'apply'
    ? plannedCandidates.map((candidate): ProcessCleanupCandidate => {
      if (candidate.action !== 'remove-state') return candidate;
      const entry = inventory.records.find((record) => record.path === candidate.path);
      if (!entry) return { ...candidate, action: 'preserve', safeToRemoveState: false, evidence: 'race-file-missing', reason: 'runtime-state record disappeared before cleanup could remove it' };
      return applyCandidate(options, inventory.stateDir, entry, candidate);
    })
    : plannedCandidates;
  const summary = summarize(inventory, candidates);
  return {
    reportVersion: 1,
    command: options.command ?? 'cleanup',
    dryRun: mode === 'dry-run',
    applySupported: true,
    applied: mode === 'apply',
    changed: summary.removedState > 0,
    generatedAt: normalizeTimestamp(options.generatedAt),
    runtimeBaseDir,
    stateDir: inventory.stateDir,
    processStateDir: inventory.stateDir,
    summary,
    candidates,
    warnings: inventory.warnings,
  };
}
