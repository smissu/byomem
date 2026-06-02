import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildByomemDoctorReport } from '../src/doctor.js';
import { registerMcpRuntimeState } from '../src/mcp/runtime-state-lifecycle.js';
import { buildProcessCleanupReport } from '../src/process-cleanup.js';
import {
  isCanonicalByomemMcpRuntimeProcess,
  readRuntimeProcessInventory,
  registerRuntimeProcess,
  runtimeProcessStateDir,
  summarizeDuplicateActiveRuntimeProcessRoles,
} from '../src/runtime-state.js';
import { buildByomemStatusReport } from '../src/status-report.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-s97-duplicates-'));
}

function activePids(pids: number[]): (pid: number) => boolean {
  return (pid) => pids.includes(pid);
}

describe('Sprint 97 duplicate active MCP role guardrails', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('returns no duplicate active role summaries for empty or single-active inventories', () => {
    const runtimeBaseDir = tempDir();
    dirs.push(runtimeBaseDir);

    expect(summarizeDuplicateActiveRuntimeProcessRoles(readRuntimeProcessInventory({
      runtimeBaseDir,
      processExists: () => true,
    }))).toEqual([]);

    registerRuntimeProcess({
      runtimeBaseDir,
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      entrypoint: 'mcp-memory',
      pid: 101,
      ppid: 1,
      argv: ['node', 'memory.js'],
      cwd: runtimeBaseDir,
      now: '2026-06-02T10:00:00.000Z',
    });

    expect(summarizeDuplicateActiveRuntimeProcessRoles(readRuntimeProcessInventory({
      runtimeBaseDir,
      processExists: activePids([101]),
    }))).toEqual([]);
  });

  it('summarizes duplicate active roles with deterministic pid and path evidence', () => {
    const runtimeBaseDir = tempDir();
    dirs.push(runtimeBaseDir);
    const second = registerRuntimeProcess({
      runtimeBaseDir,
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      entrypoint: 'mcp-memory',
      pid: 202,
      ppid: 1,
      argv: ['node', 'memory-b.js'],
      cwd: runtimeBaseDir,
      now: '2026-06-02T10:00:02.000Z',
    });
    const first = registerRuntimeProcess({
      runtimeBaseDir,
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      entrypoint: 'mcp-memory',
      pid: 101,
      ppid: 1,
      argv: ['node', 'memory-a.js'],
      cwd: runtimeBaseDir,
      now: '2026-06-02T10:00:01.000Z',
    });
    registerRuntimeProcess({
      runtimeBaseDir,
      role: 'graph',
      serverName: 'byomem-mcp-graph',
      entrypoint: 'mcp-graph',
      pid: 303,
      ppid: 1,
      argv: ['node', 'graph.js'],
      cwd: runtimeBaseDir,
      now: '2026-06-02T10:00:00.000Z',
    });

    const summaries = summarizeDuplicateActiveRuntimeProcessRoles(readRuntimeProcessInventory({
      runtimeBaseDir,
      processExists: activePids([101, 202, 303]),
    }));

    expect(summaries).toEqual([
      {
        role: 'memory',
        count: 2,
        records: [
          { pid: 101, serverName: 'byomem-mcp-memory', entrypoint: 'mcp-memory', path: first.path },
          { pid: 202, serverName: 'byomem-mcp-memory', entrypoint: 'mcp-memory', path: second.path },
        ],
      },
    ]);
  });

  it('excludes stale, malformed, and pid-missing records from duplicate active summaries', () => {
    const runtimeBaseDir = tempDir();
    dirs.push(runtimeBaseDir);
    registerRuntimeProcess({
      runtimeBaseDir,
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      entrypoint: 'mcp-memory',
      pid: 101,
      ppid: 1,
      argv: ['node', 'memory-active.js'],
      cwd: runtimeBaseDir,
      now: '2026-06-02T10:00:00.000Z',
    });
    registerRuntimeProcess({
      runtimeBaseDir,
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      entrypoint: 'mcp-memory',
      pid: 202,
      ppid: 1,
      argv: ['node', 'memory-stale.js'],
      cwd: runtimeBaseDir,
      now: '2026-06-02T09:00:00.000Z',
    });
    writeFileSync(join(runtimeProcessStateDir(runtimeBaseDir), 'pid-missing.json'), JSON.stringify({
      schemaVersion: 1,
      id: 'pid-missing',
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      ppid: 1,
      argv: ['node', 'memory.js'],
      cwd: runtimeBaseDir,
      entrypoint: 'mcp-memory',
      runtimeVersion: '0.1.21',
      startedAt: '2026-06-02T10:00:00.000Z',
      lastHeartbeatAt: '2026-06-02T10:00:00.000Z',
    }, null, 2), 'utf8');
    writeFileSync(join(runtimeProcessStateDir(runtimeBaseDir), 'bad.json'), '{bad-json', 'utf8');

    const summaries = summarizeDuplicateActiveRuntimeProcessRoles(readRuntimeProcessInventory({
      runtimeBaseDir,
      now: '2026-06-02T10:10:00.000Z',
      staleAfterMs: 5 * 60 * 1000,
      processExists: activePids([101, 202]),
    }));

    expect(summaries).toEqual([]);
  });

  it('matches canonical BYOMem MCP ownership on role, serverName, and entrypoint', () => {
    expect(isCanonicalByomemMcpRuntimeProcess({
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      entrypoint: 'mcp-memory',
    })).toBe(true);
    expect(isCanonicalByomemMcpRuntimeProcess({
      role: 'memory',
      serverName: 'byomem-mcp-graph',
      entrypoint: 'mcp-memory',
    })).toBe(false);
    expect(isCanonicalByomemMcpRuntimeProcess({
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      entrypoint: 'mcp-graph',
    })).toBe(false);
    expect(isCanonicalByomemMcpRuntimeProcess({
      role: 'custom',
      serverName: 'byomem-mcp-custom',
      entrypoint: 'mcp-custom',
    })).toBe(false);
  });

  it('adds duplicateActiveRoles to status without changing deduped roles semantics', () => {
    const runtimeBaseDir = tempDir();
    const projectBaseDir = tempDir();
    dirs.push(runtimeBaseDir, projectBaseDir);
    registerRuntimeProcess({
      runtimeBaseDir,
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      entrypoint: 'mcp-memory',
      pid: 101,
      ppid: 1,
      argv: ['node', 'memory-a.js'],
      cwd: runtimeBaseDir,
    });
    registerRuntimeProcess({
      runtimeBaseDir,
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      entrypoint: 'mcp-memory',
      pid: 202,
      ppid: 1,
      argv: ['node', 'memory-b.js'],
      cwd: runtimeBaseDir,
    });
    registerRuntimeProcess({
      runtimeBaseDir,
      role: 'graph',
      serverName: 'byomem-mcp-graph',
      entrypoint: 'mcp-graph',
      pid: 303,
      ppid: 1,
      argv: ['node', 'graph.js'],
      cwd: runtimeBaseDir,
    });

    const report = buildByomemStatusReport({
      runtimeBaseDir,
      projectBaseDir,
      processExists: activePids([101, 202, 303]),
    });

    expect(report.mcpProcesses.roles).toEqual(['graph', 'memory']);
    expect(report.mcpProcesses.duplicateActiveRoles).toEqual([
      expect.objectContaining({ role: 'memory', count: 2 }),
    ]);
  });

  it('adds structured duplicate summaries to doctor while preserving string-list compatibility', () => {
    const runtimeBaseDir = tempDir();
    const projectBaseDir = tempDir();
    dirs.push(runtimeBaseDir, projectBaseDir);
    registerRuntimeProcess({
      runtimeBaseDir,
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      entrypoint: 'mcp-memory',
      pid: 101,
      ppid: 1,
      argv: ['node', 'memory-a.js'],
      cwd: runtimeBaseDir,
    });
    registerRuntimeProcess({
      runtimeBaseDir,
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      entrypoint: 'mcp-memory',
      pid: 202,
      ppid: 1,
      argv: ['node', 'memory-b.js'],
      cwd: runtimeBaseDir,
    });

    const report = buildByomemDoctorReport({
      runtimeBaseDir,
      projectBaseDir,
      processExists: activePids([101, 202]),
    });
    const liveness = report.checks.find((check) => check.id === 'runtime-state.process-liveness');

    expect(liveness).toMatchObject({
      status: 'warn',
      evidence: {
        duplicateActiveRoles: ['memory'],
        duplicateActiveRoleSummaries: [
          expect.objectContaining({
            role: 'memory',
            count: 2,
            records: expect.arrayContaining([
              expect.objectContaining({ pid: 101, serverName: 'byomem-mcp-memory', entrypoint: 'mcp-memory' }),
            ]),
          }),
        ],
      },
      warnings: expect.arrayContaining(['Duplicate active MCP roles found: memory']),
    });
  });

  it('keeps status and doctor read-only while computing duplicate summaries', () => {
    const runtimeBaseDir = tempDir();
    const projectBaseDir = tempDir();
    dirs.push(runtimeBaseDir, projectBaseDir);
    const first = registerRuntimeProcess({
      runtimeBaseDir,
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      entrypoint: 'mcp-memory',
      pid: 101,
      ppid: 1,
      argv: ['node', 'memory-a.js'],
      cwd: runtimeBaseDir,
      now: '2026-06-02T10:00:00.000Z',
    });
    const second = registerRuntimeProcess({
      runtimeBaseDir,
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      entrypoint: 'mcp-memory',
      pid: 202,
      ppid: 1,
      argv: ['node', 'memory-b.js'],
      cwd: runtimeBaseDir,
      now: '2026-06-02T10:00:00.000Z',
    });
    const before = new Map([first.path, second.path].map((path) => [path, statSync(path).mtimeMs]));

    buildByomemStatusReport({ runtimeBaseDir, projectBaseDir, processExists: activePids([101, 202]) });
    buildByomemDoctorReport({ runtimeBaseDir, projectBaseDir, processExists: activePids([101, 202]) });

    expect(statSync(first.path).mtimeMs).toBe(before.get(first.path));
    expect(statSync(second.path).mtimeMs).toBe(before.get(second.path));
  });

  it('allows default same-role canonical lifecycle registration and leaves duplicate summaries visible', () => {
    const runtimeBaseDir = tempDir();
    dirs.push(runtimeBaseDir);
    const first = registerRuntimeProcess({
      runtimeBaseDir,
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      entrypoint: 'mcp-memory',
      pid: 101,
      ppid: 1,
      argv: ['node', 'memory-a.js'],
      cwd: runtimeBaseDir,
    });

    const lifecycle = registerMcpRuntimeState({
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      entrypoint: 'mcp-memory',
      env: { BYOMEM_RUNTIME_BASE_DIR: runtimeBaseDir },
      pid: 202,
      processExists: activePids([101, 202]),
    });

    expect(existsSync(first.path)).toBe(true);
    expect(existsSync(lifecycle.registration.path)).toBe(true);
    expect(summarizeDuplicateActiveRuntimeProcessRoles(readRuntimeProcessInventory({
      runtimeBaseDir,
      processExists: activePids([101, 202]),
    }))).toEqual([
      expect.objectContaining({
        role: 'memory',
        count: 2,
        records: [
          expect.objectContaining({ pid: 101 }),
          expect.objectContaining({ pid: 202 }),
        ],
      }),
    ]);
  });

  it('blocks strict same-role canonical lifecycle registration before leaking a second record', () => {
    const runtimeBaseDir = tempDir();
    dirs.push(runtimeBaseDir);
    registerRuntimeProcess({
      runtimeBaseDir,
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      entrypoint: 'mcp-memory',
      pid: 101,
      ppid: 1,
      argv: ['node', 'memory-a.js'],
      cwd: runtimeBaseDir,
    });

    expect(() => registerMcpRuntimeState({
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      entrypoint: 'mcp-memory',
      env: { BYOMEM_RUNTIME_BASE_DIR: runtimeBaseDir },
      duplicatePolicy: 'strict',
      pid: 202,
      processExists: activePids([101, 202]),
    })).toThrow(/Refusing to register duplicate active BYOMem MCP role memory.*101/);

    const inventory = readRuntimeProcessInventory({ runtimeBaseDir, processExists: activePids([101, 202]) });
    expect(inventory.records.filter((entry) => entry.state === 'active').map((entry) => entry.record.pid)).toEqual([101]);
  });

  it('honors BYOMEM_MCP_DUPLICATE_POLICY=strict for canonical lifecycle registration', () => {
    const runtimeBaseDir = tempDir();
    dirs.push(runtimeBaseDir);
    registerRuntimeProcess({
      runtimeBaseDir,
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      entrypoint: 'mcp-memory',
      pid: 101,
      ppid: 1,
      argv: ['node', 'memory-a.js'],
      cwd: runtimeBaseDir,
    });

    expect(() => registerMcpRuntimeState({
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      entrypoint: 'mcp-memory',
      env: {
        BYOMEM_RUNTIME_BASE_DIR: runtimeBaseDir,
        BYOMEM_MCP_DUPLICATE_POLICY: 'strict',
      },
      pid: 202,
      processExists: activePids([101, 202]),
    })).toThrow(/Refusing to register duplicate active BYOMem MCP role memory.*101/);

    const inventory = readRuntimeProcessInventory({ runtimeBaseDir, processExists: activePids([101, 202]) });
    expect(inventory.records.filter((entry) => entry.state === 'active').map((entry) => entry.record.pid)).toEqual([101]);
  });

  it('allows different-role and stale same-role lifecycle registrations', () => {
    const runtimeBaseDir = tempDir();
    dirs.push(runtimeBaseDir);
    registerRuntimeProcess({
      runtimeBaseDir,
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      entrypoint: 'mcp-memory',
      pid: 101,
      ppid: 1,
      argv: ['node', 'memory-stale.js'],
      cwd: runtimeBaseDir,
      now: '2026-06-02T09:00:00.000Z',
    });

    const graph = registerMcpRuntimeState({
      role: 'graph',
      serverName: 'byomem-mcp-graph',
      entrypoint: 'mcp-graph',
      env: { BYOMEM_RUNTIME_BASE_DIR: runtimeBaseDir },
      pid: 303,
      processExists: activePids([101, 202, 303]),
    });
    const memory = registerMcpRuntimeState({
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      entrypoint: 'mcp-memory',
      env: { BYOMEM_RUNTIME_BASE_DIR: runtimeBaseDir },
      pid: 202,
      now: '2026-06-02T10:00:00.000Z',
      staleAfterMs: 5 * 60 * 1000,
      processExists: activePids([101, 202, 303]),
    });

    expect(existsSync(graph.registration.path)).toBe(true);
    expect(existsSync(memory.registration.path)).toBe(true);
  });

  it('allows and preserves non-canonical same-role records as diagnostics-only evidence', () => {
    const runtimeBaseDir = tempDir();
    dirs.push(runtimeBaseDir);
    const nonCanonical = registerRuntimeProcess({
      runtimeBaseDir,
      role: 'memory',
      serverName: 'not-byomem-memory',
      entrypoint: 'not-mcp-memory',
      pid: 101,
      ppid: 1,
      argv: ['node', 'memory-other.js'],
      cwd: runtimeBaseDir,
    });

    const lifecycle = registerMcpRuntimeState({
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      entrypoint: 'mcp-memory',
      env: { BYOMEM_RUNTIME_BASE_DIR: runtimeBaseDir },
      pid: 202,
      processExists: activePids([101, 202]),
    });

    expect(existsSync(nonCanonical.path)).toBe(true);
    expect(existsSync(lifecycle.registration.path)).toBe(true);
    expect(summarizeDuplicateActiveRuntimeProcessRoles(readRuntimeProcessInventory({
      runtimeBaseDir,
      processExists: activePids([101, 202]),
    }))).toEqual([
      expect.objectContaining({ role: 'memory', count: 2 }),
    ]);
  });

  it('unregisters only its attempted record when a race appears after preflight in strict mode', () => {
    const runtimeBaseDir = tempDir();
    dirs.push(runtimeBaseDir);
    let competingPath = '';

    expect(() => registerMcpRuntimeState({
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      entrypoint: 'mcp-memory',
      env: { BYOMEM_RUNTIME_BASE_DIR: runtimeBaseDir },
      duplicatePolicy: 'strict',
      pid: 202,
      processExists: activePids([101, 202]),
      afterPreflight: () => {
        const competing = registerRuntimeProcess({
          runtimeBaseDir,
          role: 'memory',
          serverName: 'byomem-mcp-memory',
          entrypoint: 'mcp-memory',
          pid: 101,
          ppid: 1,
          argv: ['node', 'memory-race.js'],
          cwd: runtimeBaseDir,
        });
        competingPath = competing.path;
      },
    })).toThrow(/Race detected while registering BYOMem MCP role memory.*101/);

    expect(existsSync(competingPath)).toBe(true);
    const inventory = readRuntimeProcessInventory({ runtimeBaseDir, processExists: activePids([101, 202]) });
    expect(inventory.records.filter((entry) => entry.state === 'active').map((entry) => entry.record.pid)).toEqual([101]);
  });

  it('concurrent default same-role lifecycle attempts allow duplicate active summaries', async () => {
    const runtimeBaseDir = tempDir();
    dirs.push(runtimeBaseDir);

    const attempts = await Promise.allSettled([
      Promise.resolve().then(() => registerMcpRuntimeState({
        role: 'memory',
        serverName: 'byomem-mcp-memory',
        entrypoint: 'mcp-memory',
        env: { BYOMEM_RUNTIME_BASE_DIR: runtimeBaseDir },
        pid: 101,
        processExists: activePids([101, 202]),
      })),
      Promise.resolve().then(() => registerMcpRuntimeState({
        role: 'memory',
        serverName: 'byomem-mcp-memory',
        entrypoint: 'mcp-memory',
        env: { BYOMEM_RUNTIME_BASE_DIR: runtimeBaseDir },
        pid: 202,
        processExists: activePids([101, 202]),
      })),
    ]);

    expect(attempts.filter((entry) => entry.status === 'fulfilled')).toHaveLength(2);
    expect(attempts.filter((entry) => entry.status === 'rejected')).toHaveLength(0);
    const inventory = readRuntimeProcessInventory({ runtimeBaseDir, processExists: activePids([101, 202]) });
    expect(summarizeDuplicateActiveRuntimeProcessRoles(inventory)).toEqual([
      expect.objectContaining({ role: 'memory', count: 2 }),
    ]);
    expect(inventory.records.filter((entry) => entry.state === 'active')).toHaveLength(2);
  });

  it('concurrent strict same-role lifecycle attempts leave no duplicate active records', async () => {
    const runtimeBaseDir = tempDir();
    dirs.push(runtimeBaseDir);

    const attempts = await Promise.allSettled([
      Promise.resolve().then(() => registerMcpRuntimeState({
        role: 'memory',
        serverName: 'byomem-mcp-memory',
        entrypoint: 'mcp-memory',
        env: { BYOMEM_RUNTIME_BASE_DIR: runtimeBaseDir },
        duplicatePolicy: 'strict',
        pid: 101,
        processExists: activePids([101, 202]),
      })),
      Promise.resolve().then(() => registerMcpRuntimeState({
        role: 'memory',
        serverName: 'byomem-mcp-memory',
        entrypoint: 'mcp-memory',
        env: { BYOMEM_RUNTIME_BASE_DIR: runtimeBaseDir },
        duplicatePolicy: 'strict',
        pid: 202,
        processExists: activePids([101, 202]),
      })),
    ]);

    expect(attempts.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((entry) => entry.status === 'rejected')).toHaveLength(1);
    const inventory = readRuntimeProcessInventory({ runtimeBaseDir, processExists: activePids([101, 202]) });
    expect(summarizeDuplicateActiveRuntimeProcessRoles(inventory)).toEqual([]);
    expect(inventory.records.filter((entry) => entry.state === 'active')).toHaveLength(1);
  });

  it('cleanup apply preserves active duplicates and does not advertise duplicate remediation', () => {
    const runtimeBaseDir = tempDir();
    dirs.push(runtimeBaseDir);
    const first = registerRuntimeProcess({
      runtimeBaseDir,
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      entrypoint: 'mcp-memory',
      pid: 101,
      ppid: 1,
      argv: ['node', 'memory-a.js'],
      cwd: runtimeBaseDir,
    });
    const second = registerRuntimeProcess({
      runtimeBaseDir,
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      entrypoint: 'mcp-memory',
      pid: 202,
      ppid: 1,
      argv: ['node', 'memory-b.js'],
      cwd: runtimeBaseDir,
    });

    const report = buildProcessCleanupReport({
      runtimeBaseDir,
      mode: 'apply',
      processExists: activePids([101, 202]),
    });

    expect(report.changed).toBe(false);
    expect(existsSync(first.path)).toBe(true);
    expect(existsSync(second.path)).toBe(true);
    expect(report.candidates).toHaveLength(2);
    for (const candidate of report.candidates) {
      expect(candidate.action).toBe('none');
      expect(candidate.evidence).toBe('active');
      expect(candidate.safeToTerminate).toBe(false);
      expect(candidate.reason.toLowerCase()).not.toContain('duplicate');
      expect(candidate.reason.toLowerCase()).not.toContain('remediation');
    }
  });
});
