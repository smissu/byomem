import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { buildProcessCleanupReport } from '../src/process-cleanup.js';
import { registerRuntimeProcess, runtimeProcessStateDir } from '../src/runtime-state.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-s82-cleanup-'));
}

describe('Sprint 82 process cleanup dry-run', () => {
  const dirs: string[] = [];
  const originalRuntimeBase = process.env.BYOMEM_RUNTIME_BASE_DIR;

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    if (originalRuntimeBase === undefined) delete process.env.BYOMEM_RUNTIME_BASE_DIR;
    else process.env.BYOMEM_RUNTIME_BASE_DIR = originalRuntimeBase;
    process.exitCode = undefined;
  });

  it('classifies runtime-state records without enabling termination or state removal', () => {
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
      role: 'graph',
      serverName: 'byomem-mcp-graph',
      entrypoint: 'mcp-graph',
      pid: 202,
      ppid: 1,
      argv: ['node', 'graph.js'],
      cwd: runtimeBaseDir,
      now: '2026-05-28T10:00:00.000Z',
    });
    registerRuntimeProcess({
      runtimeBaseDir,
      role: 'file-search',
      serverName: 'byomem-mcp-file-search',
      entrypoint: 'mcp-file-search',
      pid: 303,
      ppid: 1,
      argv: ['node', 'file-search.js'],
      cwd: runtimeBaseDir,
      now: '2026-05-28T10:09:00.000Z',
    });
    writeFileSync(join(runtimeProcessStateDir(runtimeBaseDir), 'bad.json'), '{bad-json', 'utf8');

    const report = buildProcessCleanupReport({
      runtimeBaseDir,
      generatedAt: '2026-05-28T10:10:00.000Z',
      now: '2026-05-28T10:10:00.000Z',
      staleAfterMs: 5 * 60 * 1000,
      processExists: (pid) => pid === 101 || pid === 202,
    });

    expect(report).toMatchObject({
      command: 'cleanup',
      dryRun: true,
      applySupported: true,
      runtimeBaseDir,
      summary: {
        total: 3,
        active: 1,
        stale: 2,
        malformed: 1,
        wouldTerminate: 0,
        wouldRemoveState: 1,
      },
    });
    expect(report.candidates.map((candidate) => candidate.classification).sort()).toEqual([
      'active-owned',
      'malformed-state',
      'stale-heartbeat-expired',
      'stale-pid-missing',
    ]);
    expect(report.candidates.every((candidate) => candidate.safeToTerminate === false)).toBe(true);
    expect(report.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ classification: 'stale-pid-missing', action: 'would-remove-state', safeToRemoveState: true }),
      expect.objectContaining({ classification: 'stale-heartbeat-expired', action: 'preserve', safeToRemoveState: false }),
      expect.objectContaining({ classification: 'malformed-state', action: 'refuse', safeToRemoveState: false }),
    ]));
  });

  it('prints cleanup dry-run JSON from the CLI', async () => {
    const runtimeBaseDir = tempDir();
    dirs.push(runtimeBaseDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeBaseDir;
    registerRuntimeProcess({
      runtimeBaseDir,
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      entrypoint: 'mcp-memory',
      pid: 404,
      ppid: 1,
      argv: ['node', 'memory.js'],
      cwd: runtimeBaseDir,
      now: '2026-05-28T10:00:00.000Z',
    });
    const logCalls: string[] = [];
    const errorCalls: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (value?: unknown) => { logCalls.push(String(value)); };
    console.error = (value?: unknown) => { errorCalls.push(String(value)); };
    try {
      await main(['cleanup', '--base-dir', runtimeBaseDir]);
      const report = JSON.parse(logCalls.at(-1) ?? '{}') as { dryRun?: boolean; summary?: { total?: number }; candidates?: unknown[] };
      expect(process.exitCode).toBeUndefined();
      expect(report.dryRun).toBe(true);
      expect(report.summary?.total).toBe(1);
      expect(report.candidates).toHaveLength(1);

      expect(errorCalls).toHaveLength(0);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  });

  it('prints stop dry-run JSON from the CLI and rejects stop apply mode', async () => {
    const runtimeBaseDir = tempDir();
    dirs.push(runtimeBaseDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeBaseDir;
    registerRuntimeProcess({
      runtimeBaseDir,
      role: 'graph',
      serverName: 'byomem-mcp-graph',
      entrypoint: 'mcp-graph',
      pid: 505,
      ppid: 1,
      argv: ['node', 'graph.js'],
      cwd: runtimeBaseDir,
      now: '2026-05-28T10:00:00.000Z',
    });
    const logCalls: string[] = [];
    const errorCalls: string[] = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (value?: unknown) => { logCalls.push(String(value)); };
    console.error = (value?: unknown) => { errorCalls.push(String(value)); };
    try {
      await main(['stop', '--base-dir', runtimeBaseDir]);
      const report = JSON.parse(logCalls.at(-1) ?? '{}') as { command?: string; dryRun?: boolean; summary?: { total?: number } };
      expect(process.exitCode).toBeUndefined();
      expect(report.command).toBe('stop');
      expect(report.dryRun).toBe(true);
      expect(report.summary?.total).toBe(1);

      await main(['stop', '--base-dir', runtimeBaseDir, '--apply']);
      expect(process.exitCode).toBe(1);
      expect(JSON.parse(errorCalls.at(-1) ?? '{}')).toMatchObject({
        error: 'stop apply mode is not implemented; process termination is out of scope',
        command: 'stop',
      });
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  });
});
