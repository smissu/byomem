import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { registerRuntimeProcess } from '../src/runtime-state.js';
import { BYOMEM_RUNTIME_VERSION } from '../src/version.js';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('sprint 99 dashboard runtime-base selection', () => {
  const dirs: string[] = [];
  const originalRuntimeBase = process.env.BYOMEM_RUNTIME_BASE_DIR;
  const originalCwd = process.cwd();

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    process.chdir(originalCwd);
    if (originalRuntimeBase === undefined) delete process.env.BYOMEM_RUNTIME_BASE_DIR;
    else process.env.BYOMEM_RUNTIME_BASE_DIR = originalRuntimeBase;
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('preserves dashboard --base-dir as projectBaseDir while explicit --runtime-base-dir controls runtime-state evidence', async () => {
    const projectDir = tempDir('byomem-s99-project-');
    const defaultRuntimeDir = tempDir('byomem-s99-default-runtime-');
    const explicitRuntimeDir = tempDir('byomem-s99-explicit-runtime-');
    dirs.push(projectDir, defaultRuntimeDir, explicitRuntimeDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = defaultRuntimeDir;
    registerRuntimeProcess({
      runtimeBaseDir: explicitRuntimeDir,
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      entrypoint: 'mcp-memory',
      pid: process.pid,
      ppid: 1,
      argv: ['node', 'memory.js'],
      cwd: explicitRuntimeDir,
      now: '2026-06-02T00:00:00.000Z',
    });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['dashboard', '--base-dir', projectDir, '--runtime-base-dir', explicitRuntimeDir]);

    const model = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}')) as {
      projectBaseDir?: string;
      runtimeBaseDir?: string;
      runtimeProcesses?: { counts?: { total?: number; active?: number }; records?: Array<{ pid: number; role: string }> };
    };
    expect(process.exitCode).toBeUndefined();
    expect(model.projectBaseDir).toBe(projectDir);
    expect(model.runtimeBaseDir).toBe(explicitRuntimeDir);
    expect(model.runtimeProcesses?.counts).toMatchObject({ total: 1, active: 1 });
    expect(model.runtimeProcesses?.records).toEqual(expect.arrayContaining([expect.objectContaining({ pid: process.pid, role: 'memory' })]));
  });

  it('does not silently fall back to default runtime state when explicit runtime-base is provided', async () => {
    const projectDir = tempDir('byomem-s99-project-');
    const defaultRuntimeDir = tempDir('byomem-s99-default-runtime-');
    const explicitRuntimeDir = tempDir('byomem-s99-explicit-runtime-');
    dirs.push(projectDir, defaultRuntimeDir, explicitRuntimeDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = defaultRuntimeDir;
    registerRuntimeProcess({
      runtimeBaseDir: defaultRuntimeDir,
      role: 'graph',
      serverName: 'byomem-mcp-graph',
      entrypoint: 'mcp-graph',
      pid: 22222,
      ppid: 1,
      argv: ['node', 'graph.js'],
      cwd: defaultRuntimeDir,
      now: '2026-06-02T00:00:00.000Z',
    });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['dashboard', '--base-dir', projectDir, '--runtime-base-dir', explicitRuntimeDir]);

    const model = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}')) as {
      runtimeBaseDir?: string;
      runtimeProcesses?: { counts?: { total?: number }; records?: Array<{ pid: number }> };
    };
    expect(process.exitCode).toBeUndefined();
    expect(model.runtimeBaseDir).toBe(explicitRuntimeDir);
    expect(model.runtimeProcesses?.counts?.total).toBe(0);
    expect(model.runtimeProcesses?.records ?? []).not.toEqual(expect.arrayContaining([expect.objectContaining({ pid: 22222 })]));
  });

  it('uses the selected project base for dashboard doctor version alignment instead of cwd', async () => {
    const projectDir = tempDir('byomem-s99-project-');
    const cwdDir = tempDir('byomem-s99-cwd-');
    const runtimeDir = tempDir('byomem-s99-runtime-');
    dirs.push(projectDir, cwdDir, runtimeDir);
    mkdirSync(join(projectDir, 'ts/packages/runtime'), { recursive: true });
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'byomem', version: BYOMEM_RUNTIME_VERSION }), 'utf8');
    writeFileSync(join(projectDir, 'package-lock.json'), JSON.stringify({ name: 'byomem', version: BYOMEM_RUNTIME_VERSION }), 'utf8');
    writeFileSync(join(projectDir, 'ts/packages/runtime/package.json'), JSON.stringify({ name: '@byomem/runtime', version: BYOMEM_RUNTIME_VERSION }), 'utf8');
    writeFileSync(join(cwdDir, 'package.json'), '{"name":"other","version":"9.9.9"}\n', 'utf8');
    process.chdir(cwdDir);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['dashboard', '--base-dir', projectDir, '--runtime-base-dir', runtimeDir]);

    const model = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}')) as {
      overallStatus?: string;
      doctorChecks?: Array<{ id?: string; status?: string; warnings?: string[] }>;
    };
    const versionCheck = model.doctorChecks?.find((entry) => entry.id === 'version.runtime-alignment');
    expect(process.exitCode).toBeUndefined();
    expect(model.overallStatus).not.toBe('fail');
    expect(versionCheck).toMatchObject({ status: 'pass', warnings: [] });
  });

  it('lets dashboard-profile read profile evidence from explicit runtime-base', async () => {
    const projectDir = tempDir('byomem-s99-project-');
    const defaultRuntimeDir = tempDir('byomem-s99-default-runtime-');
    const explicitRuntimeDir = tempDir('byomem-s99-explicit-runtime-');
    dirs.push(projectDir, defaultRuntimeDir, explicitRuntimeDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = defaultRuntimeDir;
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['dashboard-profile', '--base-dir', projectDir, '--runtime-base-dir', explicitRuntimeDir]);

    const model = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}')) as {
      projectBaseDir?: string;
      runtimeBaseDir?: string;
    };
    expect(process.exitCode).toBeUndefined();
    expect(model.projectBaseDir).toBe(projectDir);
    expect(model.runtimeBaseDir).toBe(explicitRuntimeDir);
  });
});
