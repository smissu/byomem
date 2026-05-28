import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { BYOMEM_RUNTIME_VERSION } from './version.js';

export type RuntimeProcessRole = 'bootstrap' | 'readonly' | 'operations' | 'memory' | 'graph' | 'file-search' | string;

export type RuntimeProcessRecord = {
  schemaVersion: 1;
  id: string;
  role: RuntimeProcessRole;
  serverName: string;
  pid: number;
  ppid: number;
  argv: string[];
  cwd: string;
  entrypoint: string;
  runtimeVersion: string;
  startedAt: string;
  lastHeartbeatAt: string;
};

export type RuntimeProcessState = 'active' | 'stale';

export type RuntimeProcessInventoryEntry = {
  record: RuntimeProcessRecord;
  path: string;
  state: RuntimeProcessState;
  staleReason?: 'pid-not-running' | 'heartbeat-expired';
};

export type MalformedRuntimeProcessRecord = {
  path: string;
  error: string;
};

export type RuntimeProcessInventory = {
  stateDir: string;
  records: RuntimeProcessInventoryEntry[];
  malformed: MalformedRuntimeProcessRecord[];
  warnings: string[];
  counts: {
    total: number;
    active: number;
    stale: number;
    malformed: number;
  };
};

export type RuntimeProcessRegistration = {
  record: RuntimeProcessRecord;
  path: string;
  heartbeat(): RuntimeProcessRecord;
  unregister(): boolean;
};

export type RegisterRuntimeProcessOptions = {
  runtimeBaseDir: string;
  role: RuntimeProcessRole;
  serverName: string;
  entrypoint: string;
  pid?: number;
  ppid?: number;
  argv?: string[];
  cwd?: string;
  now?: Date | string;
};

export type RuntimeProcessInventoryOptions = {
  runtimeBaseDir: string;
  now?: Date | string;
  staleAfterMs?: number;
  processExists?: (pid: number) => boolean;
};

function normalizeTimestamp(value?: Date | string): string {
  if (value === undefined) return new Date().toISOString();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new Error('timestamp must be a valid date');
    return parsed.toISOString();
  }
  return value.toISOString();
}

function sanitizePathPart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'process';
}

export function runtimeProcessStateDir(runtimeBaseDir: string): string {
  return resolve(runtimeBaseDir, 'runtime-state', 'processes');
}

function runtimeProcessRecordPath(runtimeBaseDir: string, record: Pick<RuntimeProcessRecord, 'role' | 'pid' | 'id'>): string {
  return join(runtimeProcessStateDir(runtimeBaseDir), `${sanitizePathPart(record.role)}-${record.pid}-${sanitizePathPart(record.id)}.json`);
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmpPath, path);
}

function defaultProcessExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseRuntimeProcessRecord(raw: unknown): RuntimeProcessRecord {
  if (!raw || typeof raw !== 'object') throw new Error('record must be an object');
  const record = raw as Partial<RuntimeProcessRecord>;
  if (record.schemaVersion !== 1) throw new Error('unsupported runtime process schemaVersion');
  if (typeof record.id !== 'string' || !record.id.trim()) throw new Error('record.id must be a non-empty string');
  if (typeof record.role !== 'string' || !record.role.trim()) throw new Error('record.role must be a non-empty string');
  if (typeof record.serverName !== 'string' || !record.serverName.trim()) throw new Error('record.serverName must be a non-empty string');
  if (typeof record.pid !== 'number' || !Number.isSafeInteger(record.pid) || record.pid <= 0) throw new Error('record.pid must be a positive integer');
  if (typeof record.ppid !== 'number' || !Number.isSafeInteger(record.ppid) || record.ppid < 0) throw new Error('record.ppid must be a non-negative integer');
  if (!Array.isArray(record.argv) || record.argv.some((entry) => typeof entry !== 'string')) throw new Error('record.argv must be a string array');
  if (typeof record.cwd !== 'string' || !record.cwd.trim()) throw new Error('record.cwd must be a non-empty string');
  if (typeof record.entrypoint !== 'string' || !record.entrypoint.trim()) throw new Error('record.entrypoint must be a non-empty string');
  if (typeof record.runtimeVersion !== 'string' || !record.runtimeVersion.trim()) throw new Error('record.runtimeVersion must be a non-empty string');
  if (typeof record.startedAt !== 'string' || Number.isNaN(Date.parse(record.startedAt))) throw new Error('record.startedAt must be an ISO timestamp');
  if (typeof record.lastHeartbeatAt !== 'string' || Number.isNaN(Date.parse(record.lastHeartbeatAt))) throw new Error('record.lastHeartbeatAt must be an ISO timestamp');
  return {
    schemaVersion: 1,
    id: record.id,
    role: record.role,
    serverName: record.serverName,
    pid: record.pid,
    ppid: record.ppid,
    argv: record.argv,
    cwd: record.cwd,
    entrypoint: record.entrypoint,
    runtimeVersion: record.runtimeVersion,
    startedAt: record.startedAt,
    lastHeartbeatAt: record.lastHeartbeatAt,
  };
}

function matchesRegistration(existing: RuntimeProcessRecord, expected: RuntimeProcessRecord): boolean {
  return existing.id === expected.id
    && existing.pid === expected.pid
    && existing.serverName === expected.serverName
    && existing.entrypoint === expected.entrypoint
    && existing.startedAt === expected.startedAt;
}

export function registerRuntimeProcess(options: RegisterRuntimeProcessOptions): RuntimeProcessRegistration {
  const startedAt = normalizeTimestamp(options.now);
  const record: RuntimeProcessRecord = {
    schemaVersion: 1,
    id: randomUUID(),
    role: options.role,
    serverName: options.serverName,
    pid: options.pid ?? process.pid,
    ppid: options.ppid ?? process.ppid,
    argv: options.argv ?? process.argv,
    cwd: options.cwd ?? process.cwd(),
    entrypoint: options.entrypoint,
    runtimeVersion: BYOMEM_RUNTIME_VERSION,
    startedAt,
    lastHeartbeatAt: startedAt,
  };
  const path = runtimeProcessRecordPath(options.runtimeBaseDir, record);
  writeJsonAtomic(path, record);

  const heartbeat = (): RuntimeProcessRecord => {
    const next = { ...record, lastHeartbeatAt: normalizeTimestamp() };
    writeJsonAtomic(path, next);
    record.lastHeartbeatAt = next.lastHeartbeatAt;
    return next;
  };

  const unregister = (): boolean => unregisterRuntimeProcess(options.runtimeBaseDir, record, path);

  return { record, path, heartbeat, unregister };
}

export function unregisterRuntimeProcess(runtimeBaseDir: string, expected: RuntimeProcessRecord, path = runtimeProcessRecordPath(runtimeBaseDir, expected)): boolean {
  if (!existsSync(path)) return false;
  try {
    const existing = parseRuntimeProcessRecord(JSON.parse(readFileSync(path, 'utf8')) as unknown);
    if (!matchesRegistration(existing, expected)) return false;
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function readRuntimeProcessInventory(options: RuntimeProcessInventoryOptions): RuntimeProcessInventory {
  const stateDir = runtimeProcessStateDir(options.runtimeBaseDir);
  const processExists = options.processExists ?? defaultProcessExists;
  const nowMs = Date.parse(normalizeTimestamp(options.now));
  const records: RuntimeProcessInventoryEntry[] = [];
  const malformed: MalformedRuntimeProcessRecord[] = [];
  const warnings: string[] = [];

  if (!existsSync(stateDir)) {
    return {
      stateDir,
      records,
      malformed,
      warnings: [`runtime process state directory is missing: ${stateDir}`],
      counts: { total: 0, active: 0, stale: 0, malformed: 0 },
    };
  }

  for (const fileName of readdirSync(stateDir).sort()) {
    if (!fileName.endsWith('.json')) continue;
    const path = join(stateDir, basename(fileName));
    try {
      const record = parseRuntimeProcessRecord(JSON.parse(readFileSync(path, 'utf8')) as unknown);
      const lastHeartbeatMs = Date.parse(record.lastHeartbeatAt);
      const heartbeatExpired = options.staleAfterMs !== undefined && nowMs - lastHeartbeatMs > options.staleAfterMs;
      const pidRunning = processExists(record.pid);
      const state: RuntimeProcessState = pidRunning && !heartbeatExpired ? 'active' : 'stale';
      records.push({
        record,
        path,
        state,
        ...(state === 'stale' ? { staleReason: pidRunning ? 'heartbeat-expired' : 'pid-not-running' } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      malformed.push({ path, error: message });
      warnings.push(`malformed runtime process record ${path}: ${message}`);
    }
  }

  const active = records.filter((entry) => entry.state === 'active').length;
  const stale = records.filter((entry) => entry.state === 'stale').length;
  return {
    stateDir,
    records,
    malformed,
    warnings,
    counts: {
      total: records.length,
      active,
      stale,
      malformed: malformed.length,
    },
  };
}
