import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { buildProcessCleanupReport } from '../src/process-cleanup.js';
import { registerRuntimeProcess, runtimeProcessStateDir } from '../src/runtime-state.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-s96-cleanup-'));
}

describe('Sprint 96 cleanup apply', () => {
  const dirs: string[] = [];
  const originalRuntimeBase = process.env.BYOMEM_RUNTIME_BASE_DIR;

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    if (originalRuntimeBase === undefined) delete process.env.BYOMEM_RUNTIME_BASE_DIR;
    else process.env.BYOMEM_RUNTIME_BASE_DIR = originalRuntimeBase;
    process.exitCode = undefined;
  });

  function makeRuntime(): string {
    const runtimeBaseDir = tempDir();
    dirs.push(runtimeBaseDir);
    mkdirSync(runtimeProcessStateDir(runtimeBaseDir), { recursive: true });
    return runtimeBaseDir;
  }

  it('removes only stale BYOMem-owned pid-missing runtime-state records', () => {
    const runtimeBaseDir = makeRuntime();
    const stale = registerRuntimeProcess({
      runtimeBaseDir,
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      entrypoint: 'mcp-memory',
      pid: 999991,
      ppid: 1,
      argv: ['node', '/old/byomem/runtime/mcp/memory.js'],
      cwd: runtimeBaseDir,
      now: '2026-06-02T07:00:00.000Z',
    });
    const movedInstall = registerRuntimeProcess({
      runtimeBaseDir,
      role: 'operations',
      serverName: 'byomem-mcp-operations',
      entrypoint: 'mcp-operations',
      pid: 999992,
      ppid: 1,
      argv: ['node', '/deleted/install/runtime/mcp/operations.js'],
      cwd: runtimeBaseDir,
      now: '2026-06-02T07:00:00.000Z',
    });
    const active = registerRuntimeProcess({
      runtimeBaseDir,
      role: 'graph',
      serverName: 'byomem-mcp-graph',
      entrypoint: 'mcp-graph',
      pid: 101,
      ppid: 1,
      argv: ['node', 'graph.js'],
      cwd: runtimeBaseDir,
      now: '2026-06-02T07:00:00.000Z',
    });
    const heartbeatExpired = registerRuntimeProcess({
      runtimeBaseDir,
      role: 'file-search',
      serverName: 'byomem-mcp-file-search',
      entrypoint: 'mcp-file-search',
      pid: 202,
      ppid: 1,
      argv: ['node', 'file-search.js'],
      cwd: runtimeBaseDir,
      now: '2026-06-02T06:00:00.000Z',
    });
    const nearMatch = registerRuntimeProcess({
      runtimeBaseDir,
      role: 'graph',
      serverName: 'byomem-mcp-graph',
      entrypoint: 'mcp-graph',
      pid: 999993,
      ppid: 1,
      argv: ['node', '/current/runtime/mcp/graph.js.bak'],
      cwd: runtimeBaseDir,
      now: '2026-06-02T07:00:00.000Z',
    });
    const malformedPath = join(runtimeProcessStateDir(runtimeBaseDir), 'bad.json');
    writeFileSync(malformedPath, '{bad-json', 'utf8');
    const durableFiles = [
      join(runtimeBaseDir, 'native-store.json'),
      join(runtimeBaseDir, 'byomem-index.sqlite'),
      join(runtimeBaseDir, 'byomem-file-search.sqlite'),
      join(runtimeBaseDir, 'byomem-graph.sqlite'),
    ];
    for (const path of durableFiles) writeFileSync(path, 'durable', 'utf8');

    const report = buildProcessCleanupReport({
      runtimeBaseDir,
      mode: 'apply',
      generatedAt: '2026-06-02T07:10:00.000Z',
      now: '2026-06-02T07:10:00.000Z',
      staleAfterMs: 5 * 60 * 1000,
      processExists: (pid) => pid === 101 || pid === 202,
    });

    expect(report).toMatchObject({
      dryRun: false,
      applySupported: true,
      applied: true,
      changed: true,
      summary: {
        removedState: 2,
        failed: 0,
      },
    });
    expect(existsSync(stale.path)).toBe(false);
    expect(existsSync(movedInstall.path)).toBe(false);
    expect(existsSync(active.path)).toBe(true);
    expect(existsSync(heartbeatExpired.path)).toBe(true);
    expect(existsSync(nearMatch.path)).toBe(true);
    expect(existsSync(malformedPath)).toBe(true);
    for (const path of durableFiles) expect(existsSync(path)).toBe(true);
    expect(report.candidates.every((candidate) => candidate.safeToTerminate === false)).toBe(true);

    const second = buildProcessCleanupReport({
      runtimeBaseDir,
      mode: 'apply',
      now: '2026-06-02T07:10:00.000Z',
      staleAfterMs: 5 * 60 * 1000,
      processExists: (pid) => pid === 101 || pid === 202,
    });
    expect(second.changed).toBe(false);
    expect(second.summary.removedState).toBe(0);
  });

  it('refuses stale records that change ownership during second-pass apply', () => {
    const runtimeBaseDir = makeRuntime();
    const stale = registerRuntimeProcess({
      runtimeBaseDir,
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      entrypoint: 'mcp-memory',
      pid: 999994,
      ppid: 1,
      argv: ['node', 'memory.js'],
      cwd: runtimeBaseDir,
      now: '2026-06-02T07:00:00.000Z',
    });

    const report = buildProcessCleanupReport({
      runtimeBaseDir,
      mode: 'apply',
      now: '2026-06-02T07:10:00.000Z',
      processExists: () => false,
      beforeApplyCandidate: () => {
        writeFileSync(stale.path, `${JSON.stringify({
          ...stale.record,
          serverName: 'not-byomem',
        }, null, 2)}\n`, 'utf8');
      },
    });

    expect(report.changed).toBe(false);
    expect(report.summary.refused).toBeGreaterThanOrEqual(1);
    expect(report.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'refuse', evidence: 'race-identity-changed' }),
    ]));
    expect(existsSync(stale.path)).toBe(true);
  });

  it('refuses BYOMem-looking but non-canonical stale runtime-state records', () => {
    const runtimeBaseDir = makeRuntime();
    const nonCanonical = registerRuntimeProcess({
      runtimeBaseDir,
      role: 'anything',
      serverName: 'byomem-mcp-notcanonical',
      entrypoint: 'mcp-anything',
      pid: 999997,
      ppid: 1,
      argv: ['node', 'anything.js'],
      cwd: runtimeBaseDir,
      now: '2026-06-02T07:00:00.000Z',
    });

    const report = buildProcessCleanupReport({
      runtimeBaseDir,
      mode: 'apply',
      now: '2026-06-02T07:10:00.000Z',
      processExists: () => false,
    });

    expect(report.changed).toBe(false);
    expect(report.summary.removedState).toBe(0);
    expect(report.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'refuse', evidence: 'ownership-mismatch' }),
    ]));
    expect(existsSync(nonCanonical.path)).toBe(true);
  });

  it('accepts cleanup apply in the CLI and rejects unsafe cleanup and stop flags', async () => {
    const runtimeBaseDir = makeRuntime();
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeBaseDir;
    const stale = registerRuntimeProcess({
      runtimeBaseDir,
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      entrypoint: 'mcp-memory',
      pid: 999995,
      ppid: 1,
      argv: ['node', 'memory.js'],
      cwd: runtimeBaseDir,
      now: '2026-06-02T07:00:00.000Z',
    });
    const logCalls: string[] = [];
    const errorCalls: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (value?: unknown) => { logCalls.push(String(value)); };
    console.error = (value?: unknown) => { errorCalls.push(String(value)); };
    try {
      await main(['cleanup', '--base-dir', runtimeBaseDir, '--apply']);
      expect(process.exitCode).toBeUndefined();
      const report = JSON.parse(logCalls.at(-1) ?? '{}') as { dryRun?: boolean; changed?: boolean; summary?: { removedState?: number } };
      expect(report.dryRun).toBe(false);
      expect(report.changed).toBe(true);
      expect(report.summary?.removedState).toBe(1);
      expect(existsSync(stale.path)).toBe(false);

      for (const args of [
        ['cleanup', '--base-dir', runtimeBaseDir, '--apply', '--dry-run'],
        ['cleanup', '--base-dir', runtimeBaseDir, '--delete-data'],
        ['cleanup', '--base-dir', runtimeBaseDir, '--kill-processes'],
        ['cleanup', '--base-dir', runtimeBaseDir, '--force'],
        ['stop', '--base-dir', runtimeBaseDir, '--apply'],
        ['stop', '--base-dir', runtimeBaseDir, '--delete-data'],
        ['stop', '--base-dir', runtimeBaseDir, '--kill-processes'],
        ['stop', '--base-dir', runtimeBaseDir, '--force'],
      ]) {
        process.exitCode = undefined;
        await main(args);
        expect(process.exitCode).toBe(1);
      }
      expect(errorCalls.length).toBeGreaterThanOrEqual(8);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  });
});
