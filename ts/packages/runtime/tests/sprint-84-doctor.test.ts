import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { buildByomemDoctorReport } from '../src/doctor.js';
import { registerRuntimeProcess } from '../src/runtime-state.js';
import { BYOMEM_RUNTIME_VERSION } from '../src/version.js';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('sprint 84 doctor diagnostics', () => {
  const dirs: string[] = [];
  const originalRuntimeBase = process.env.BYOMEM_RUNTIME_BASE_DIR;
  const originalDoctorProcessEvidenceConfidence = process.env.BYOMEM_DOCTOR_PROCESS_EVIDENCE_CONFIDENCE;

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    if (originalRuntimeBase === undefined) delete process.env.BYOMEM_RUNTIME_BASE_DIR;
    else process.env.BYOMEM_RUNTIME_BASE_DIR = originalRuntimeBase;
    if (originalDoctorProcessEvidenceConfidence === undefined) delete process.env.BYOMEM_DOCTOR_PROCESS_EVIDENCE_CONFIDENCE;
    else process.env.BYOMEM_DOCTOR_PROCESS_EVIDENCE_CONFIDENCE = originalDoctorProcessEvidenceConfidence;
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('builds a stable read-only doctor report with checks and suggested commands', () => {
    const runtimeDir = tempDir('byomem-doctor-runtime-');
    const projectDir = tempDir('byomem-doctor-project-');
    const configDir = tempDir('byomem-doctor-config-');
    dirs.push(runtimeDir, projectDir, configDir);
    writeFileSync(join(runtimeDir, 'byomem-index.sqlite'), 'memory sqlite payload', 'utf8');
    writeFileSync(join(runtimeDir, 'byomem-file-search.sqlite'), 'file search sqlite payload', 'utf8');
    writeFileSync(join(runtimeDir, 'byomem-graph.sqlite'), 'graph sqlite payload', 'utf8');
    const codexConfigPath = join(configDir, 'config.toml');
    writeFileSync(codexConfigPath, '[mcp_servers.byomem]\ncommand = "byomem"\n', 'utf8');
    registerRuntimeProcess({
      runtimeBaseDir: runtimeDir,
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      entrypoint: 'mcp-memory',
      pid: 1234,
      ppid: 1,
      argv: ['node', 'memory.js'],
      cwd: runtimeDir,
      now: '2026-05-28T10:00:00.000Z',
    });

    const report = buildByomemDoctorReport({
      runtimeBaseDir: runtimeDir,
      projectBaseDir: projectDir,
      generatedAt: '2026-05-28T12:00:00.000Z',
      codexConfigPath,
      processExists: (pid) => pid === 1234,
    });

    expect(report).toMatchObject({
      command: 'doctor',
      version: BYOMEM_RUNTIME_VERSION,
      runtimeVersion: BYOMEM_RUNTIME_VERSION,
      generatedAt: '2026-05-28T12:00:00.000Z',
      projectBaseDir: projectDir,
      runtimeBaseDir: runtimeDir,
      overallStatus: 'pass',
    });
    expect(report.checks.map((check) => check.id)).toEqual(expect.arrayContaining([
      'version.runtime-alignment',
      'memory.artifacts',
      'file-search.artifacts',
      'graph.artifacts',
      'codex.config-presence',
      'runtime-state.inventory',
      'runtime-state.process-liveness',
      'file-search.embedding-health',
      'doctor.read-only-boundary',
    ]));
    expect(report.checks.find((check) => check.id === 'runtime-state.process-liveness')).toMatchObject({
      status: 'pass',
      evidenceConfidence: 'definite',
    });
    expect(report.checks.find((check) => check.id === 'file-search.embedding-health')).toMatchObject({
      status: 'skipped',
      evidenceConfidence: 'not-applicable',
    });
    expect(report.checks.every((check) => Object.hasOwn(check, 'skippedReason'))).toBe(true);
    expect(report.suggestedActions.every((entry) => entry.mode === 'read-only')).toBe(true);
  });

  it('detects package version drift instead of only comparing runtime constants', () => {
    const runtimeDir = tempDir('byomem-doctor-runtime-');
    const projectDir = tempDir('byomem-doctor-project-');
    dirs.push(runtimeDir, projectDir);
    writeFileSync(join(projectDir, 'package.json'), '{"name":"byomem","version":"0.1.7"}\n', 'utf8');

    const report = buildByomemDoctorReport({
      runtimeBaseDir: runtimeDir,
      projectBaseDir: projectDir,
      versionBaseDir: projectDir,
      generatedAt: '2026-05-28T12:00:00.000Z',
    });
    const check = report.checks.find((entry) => entry.id === 'version.runtime-alignment');

    expect(report.overallStatus).toBe('fail');
    expect(check).toMatchObject({
      status: 'fail',
      severity: 'high',
      evidence: {
        runtimeVersionConstant: BYOMEM_RUNTIME_VERSION,
        files: expect.arrayContaining([expect.objectContaining({ path: join(projectDir, 'package.json'), version: '0.1.7' })]),
      },
      warnings: expect.arrayContaining([expect.stringContaining('0.1.7')]),
    });
  });

  it('keeps constrained stale process evidence at warn severity', () => {
    const runtimeDir = tempDir('byomem-doctor-runtime-');
    const projectDir = tempDir('byomem-doctor-project-');
    dirs.push(runtimeDir, projectDir);
    registerRuntimeProcess({
      runtimeBaseDir: runtimeDir,
      role: 'file-search',
      serverName: 'byomem-mcp-file-search',
      entrypoint: 'mcp-file-search',
      pid: 5678,
      ppid: 1,
      argv: ['node', 'file-search.js'],
      cwd: runtimeDir,
      now: '2026-05-28T10:00:00.000Z',
    });

    const report = buildByomemDoctorReport({
      runtimeBaseDir: runtimeDir,
      projectBaseDir: projectDir,
      generatedAt: '2026-05-28T12:00:00.000Z',
      processExists: () => false,
      processEvidenceConfidence: 'constrained',
    });
    const check = report.checks.find((entry) => entry.id === 'runtime-state.process-liveness');

    expect(report.overallStatus).toBe('warn');
    expect(check).toMatchObject({
      status: 'warn',
      severity: 'medium',
      evidenceConfidence: 'constrained',
      evidence: {
        counts: expect.objectContaining({ total: 1, active: 0, stale: 1, malformed: 0 }),
      },
      warnings: expect.arrayContaining([expect.stringContaining('constrained')]),
    });
  });

  it('does not create BYOMem artifacts while diagnosing missing runtime state', () => {
    const runtimeDir = tempDir('byomem-doctor-runtime-');
    const projectDir = tempDir('byomem-doctor-project-');
    dirs.push(runtimeDir, projectDir);

    const report = buildByomemDoctorReport({
      runtimeBaseDir: runtimeDir,
      projectBaseDir: projectDir,
      generatedAt: '2026-05-28T12:00:00.000Z',
    });

    expect(report.overallStatus).toBe('warn');
    expect(existsSync(join(runtimeDir, 'native-store.json'))).toBe(false);
    expect(existsSync(join(runtimeDir, 'byomem-index.sqlite'))).toBe(false);
    expect(existsSync(join(runtimeDir, 'byomem-file-search.sqlite'))).toBe(false);
    expect(existsSync(join(runtimeDir, 'byomem-graph.sqlite'))).toBe(false);
    expect(existsSync(join(runtimeDir, 'runtime-state'))).toBe(false);
  });

  it('prints doctor JSON from the CLI without creating stores', async () => {
    const runtimeDir = tempDir('byomem-doctor-runtime-');
    dirs.push(runtimeDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['doctor', '--base-dir', runtimeDir]);

    const report = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}')) as {
      command?: string;
      runtimeBaseDir?: string;
      checks?: Array<{ id: string }>;
    };
    expect(process.exitCode).toBeUndefined();
    expect(report.command).toBe('doctor');
    expect(report.runtimeBaseDir).toBe(runtimeDir);
    expect(report.checks?.map((check) => check.id)).toContain('doctor.read-only-boundary');
    expect(existsSync(join(runtimeDir, 'byomem-index.sqlite'))).toBe(false);
    expect(existsSync(join(runtimeDir, 'byomem-file-search.sqlite'))).toBe(false);
    expect(existsSync(join(runtimeDir, 'byomem-graph.sqlite'))).toBe(false);
  });

  it('lets the CLI report constrained PID evidence when the environment requires it', async () => {
    const runtimeDir = tempDir('byomem-doctor-runtime-');
    dirs.push(runtimeDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    process.env.BYOMEM_DOCTOR_PROCESS_EVIDENCE_CONFIDENCE = 'constrained';
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['doctor', '--base-dir', runtimeDir]);

    const report = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}')) as {
      checks?: Array<{ id: string; evidenceConfidence: string }>;
    };
    expect(report.checks?.find((check) => check.id === 'runtime-state.process-liveness')).toMatchObject({
      evidenceConfidence: 'constrained',
    });
  });

  it('rejects doctor apply mode before any cleanup mutation path can run', async () => {
    const runtimeDir = tempDir('byomem-doctor-runtime-');
    dirs.push(runtimeDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await main(['doctor', '--base-dir', runtimeDir, '--apply']);

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(String(errSpy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      error: 'doctor is read-only; --apply is not supported',
      command: 'doctor',
    });
    expect(existsSync(join(runtimeDir, 'runtime-state'))).toBe(false);
  });
});
