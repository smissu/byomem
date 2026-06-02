import { resolveDefaultRuntimeBaseDir } from '../readonly-core.js';
import {
  isCanonicalByomemMcpRuntimeProcess,
  readRuntimeProcessInventory,
  registerRuntimeProcess,
  type RuntimeProcessInventoryEntry,
  type RuntimeProcessRegistration,
  type RuntimeProcessRole,
} from '../runtime-state.js';

export type RuntimeStateLifecycleOptions = {
  role: RuntimeProcessRole;
  serverName: string;
  entrypoint: string;
  env?: NodeJS.ProcessEnv;
  runtimeBaseDir?: string;
  pid?: number;
  ppid?: number;
  argv?: string[];
  cwd?: string;
  now?: Date | string;
  staleAfterMs?: number;
  processExists?: (pid: number) => boolean;
  afterPreflight?: (context: { runtimeBaseDir: string }) => void;
  afterRegister?: (context: { runtimeBaseDir: string; registration: RuntimeProcessRegistration }) => void;
};

export type RuntimeStateLifecycle = {
  registration: RuntimeProcessRegistration;
  unregister(): boolean;
};

function activeCanonicalEntriesForRole(options: RuntimeStateLifecycleOptions, runtimeBaseDir: string): RuntimeProcessInventoryEntry[] {
  const inventory = readRuntimeProcessInventory({
    runtimeBaseDir,
    now: options.now,
    staleAfterMs: options.staleAfterMs,
    processExists: options.processExists,
  });
  return inventory.records
    .filter((entry) => entry.state === 'active')
    .filter((entry) => entry.record.role === options.role)
    .filter((entry) => isCanonicalByomemMcpRuntimeProcess(entry.record))
    .sort((a, b) => a.record.pid - b.record.pid || a.path.localeCompare(b.path));
}

function duplicateRoleError(prefix: string, role: RuntimeProcessRole, entries: RuntimeProcessInventoryEntry[]): Error {
  const pids = entries.map((entry) => entry.record.pid).join(', ');
  return new Error(`${prefix} BYOMem MCP role ${role}; active canonical record pid(s): ${pids}`);
}

export function registerMcpRuntimeState(options: RuntimeStateLifecycleOptions): RuntimeStateLifecycle {
  const runtimeBaseDir = options.runtimeBaseDir ?? resolveDefaultRuntimeBaseDir(options.env ?? process.env);
  const canonicalAttempt = isCanonicalByomemMcpRuntimeProcess(options);

  if (canonicalAttempt) {
    const existing = activeCanonicalEntriesForRole(options, runtimeBaseDir);
    if (existing.length > 0) {
      throw duplicateRoleError('Refusing to register duplicate active', options.role, existing);
    }
  }
  options.afterPreflight?.({ runtimeBaseDir });

  const registration = registerRuntimeProcess({
    runtimeBaseDir,
    role: options.role,
    serverName: options.serverName,
    entrypoint: options.entrypoint,
    pid: options.pid,
    ppid: options.ppid,
    argv: options.argv,
    cwd: options.cwd,
    now: options.now,
  });
  options.afterRegister?.({ runtimeBaseDir, registration });

  if (canonicalAttempt) {
    const active = activeCanonicalEntriesForRole(options, runtimeBaseDir);
    const duplicate = active.filter((entry) => entry.path !== registration.path);
    if (duplicate.length > 0) {
      registration.unregister();
      throw duplicateRoleError('Race detected while registering', options.role, duplicate);
    }
  }

  let unregistered = false;
  const unregister = (): boolean => {
    if (unregistered) return false;
    unregistered = true;
    return registration.unregister();
  };
  return { registration, unregister };
}

export function installRuntimeStateSignalHandlers(lifecycle: RuntimeStateLifecycle): () => void {
  const onExit = () => { lifecycle.unregister(); };
  const onSigint = () => {
    lifecycle.unregister();
    process.exitCode = 130;
    process.exit(130);
  };
  const onSigterm = () => {
    lifecycle.unregister();
    process.exitCode = 143;
    process.exit(143);
  };
  process.once('exit', onExit);
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  return () => {
    process.removeListener('exit', onExit);
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  };
}
