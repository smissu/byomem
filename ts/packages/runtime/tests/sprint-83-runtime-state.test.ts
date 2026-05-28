import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readRuntimeProcessInventory,
  registerRuntimeProcess,
  runtimeProcessStateDir,
  unregisterRuntimeProcess,
} from '../src/runtime-state.js';
import { BYOMEM_RUNTIME_VERSION } from '../src/version.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-s83-runtime-state-'));
}

describe('Sprint 83 runtime process state registry', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('registers and unregisters a process with an atomic per-pid JSON record', () => {
    const runtimeBaseDir = tempDir();
    dirs.push(runtimeBaseDir);

    const registration = registerRuntimeProcess({
      runtimeBaseDir,
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      entrypoint: 'mcp-memory',
      pid: 12345,
      ppid: 111,
      argv: ['node', 'memory.js'],
      cwd: runtimeBaseDir,
      now: '2026-05-28T10:00:00.000Z',
    });

    expect(registration.path.startsWith(runtimeProcessStateDir(runtimeBaseDir))).toBe(true);
    expect(existsSync(registration.path)).toBe(true);
    expect(JSON.parse(readFileSync(registration.path, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      pid: 12345,
      ppid: 111,
      argv: ['node', 'memory.js'],
      cwd: runtimeBaseDir,
      entrypoint: 'mcp-memory',
      runtimeVersion: BYOMEM_RUNTIME_VERSION,
      startedAt: '2026-05-28T10:00:00.000Z',
      lastHeartbeatAt: '2026-05-28T10:00:00.000Z',
    });

    expect(registration.unregister()).toBe(true);
    expect(existsSync(registration.path)).toBe(false);
  });

  it('refuses to unregister a record when pid or metadata no longer match', () => {
    const runtimeBaseDir = tempDir();
    dirs.push(runtimeBaseDir);
    const registration = registerRuntimeProcess({
      runtimeBaseDir,
      role: 'graph',
      serverName: 'byomem-mcp-graph',
      entrypoint: 'mcp-graph',
      pid: 222,
      ppid: 1,
      argv: ['node', 'graph.js'],
      cwd: runtimeBaseDir,
      now: '2026-05-28T10:00:00.000Z',
    });
    const hijacked = { ...registration.record, pid: 999 };
    writeFileSync(registration.path, `${JSON.stringify(hijacked, null, 2)}\n`, 'utf8');

    expect(unregisterRuntimeProcess(runtimeBaseDir, registration.record, registration.path)).toBe(false);
    expect(existsSync(registration.path)).toBe(true);
  });

  it('lists active, stale, and malformed records without shell process inspection', () => {
    const runtimeBaseDir = tempDir();
    dirs.push(runtimeBaseDir);
    registerRuntimeProcess({
      runtimeBaseDir,
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      entrypoint: 'mcp-memory',
      pid: 101,
      ppid: 1,
      argv: ['node', 'memory.js'],
      cwd: runtimeBaseDir,
      now: '2026-05-28T10:09:00.000Z',
    });
    registerRuntimeProcess({
      runtimeBaseDir,
      role: 'file-search',
      serverName: 'byomem-mcp-file-search',
      entrypoint: 'mcp-file-search',
      pid: 202,
      ppid: 1,
      argv: ['node', 'file-search.js'],
      cwd: runtimeBaseDir,
      now: '2026-05-28T09:00:00.000Z',
    });
    writeFileSync(join(runtimeProcessStateDir(runtimeBaseDir), 'bad.json'), '{not-json', 'utf8');

    const inventory = readRuntimeProcessInventory({
      runtimeBaseDir,
      now: '2026-05-28T10:10:00.000Z',
      staleAfterMs: 5 * 60 * 1000,
      processExists: (pid) => pid === 101 || pid === 202,
    });

    expect(inventory.counts).toEqual({ total: 2, active: 1, stale: 1, malformed: 1 });
    expect(inventory.records.map((entry) => ({ role: entry.record.role, state: entry.state, staleReason: entry.staleReason }))).toEqual([
      { role: 'file-search', state: 'stale', staleReason: 'heartbeat-expired' },
      { role: 'memory', state: 'active', staleReason: undefined },
    ]);
    expect(inventory.malformed).toHaveLength(1);
    expect(inventory.warnings[0]).toContain('malformed runtime process record');
  });

  it('marks records stale when the injected process probe reports the pid missing', () => {
    const runtimeBaseDir = tempDir();
    dirs.push(runtimeBaseDir);
    registerRuntimeProcess({
      runtimeBaseDir,
      role: 'operations',
      serverName: 'byomem-mcp-operations',
      entrypoint: 'mcp-operations',
      pid: 303,
      ppid: 1,
      argv: ['node', 'operations.js'],
      cwd: runtimeBaseDir,
      now: '2026-05-28T10:00:00.000Z',
    });

    const inventory = readRuntimeProcessInventory({
      runtimeBaseDir,
      now: '2026-05-28T10:01:00.000Z',
      staleAfterMs: 5 * 60 * 1000,
      processExists: () => false,
    });

    expect(inventory.counts).toEqual({ total: 1, active: 0, stale: 1, malformed: 0 });
    expect(inventory.records[0]?.staleReason).toBe('pid-not-running');
  });
});
