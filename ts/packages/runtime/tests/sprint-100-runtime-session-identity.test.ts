import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerMcpRuntimeState } from '../src/mcp/runtime-state-lifecycle.js';
import {
  readRuntimeProcessInventory,
  registerRuntimeProcess,
  runtimeProcessStateDir,
} from '../src/runtime-state.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-s100-runtime-identity-'));
}

function writeRuntimeRecord(path: string, record: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

describe('Sprint 100 runtime session identity contract', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('registerRuntimeProcess accepts optional safe identity fields and writes them', () => {
    const runtimeBaseDir = tempDir();
    dirs.push(runtimeBaseDir);

    const registration = registerRuntimeProcess({
      runtimeBaseDir,
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      entrypoint: 'mcp-memory',
      pid: 23456,
      ppid: 1,
      argv: ['node', 'memory.js'],
      cwd: '/Users/alice/work/project-one',
      now: '2026-06-04T09:00:00.000Z',
      identity: {
        projectKey: 'Project One From ENV /Users/alice/work/project-one',
        projectDisplayName: 'Project One <script>alert(1)</script>',
        projectBaseDir: '/Users/alice/work/project-one',
        projectSource: 'env',
        sessionKey: 'raw-session-id-abcdef1234567890',
        sessionLabel: 'Session 01\n<script>alert(1)</script>',
        clientInstanceId: 'client-host.example.com:9123',
      },
    } as any);

    const written = JSON.parse(readFileSync(registration.path, 'utf8')) as Record<string, unknown>;

    expect(written.schemaVersion).toBe(1);
    expect(written.identity).toMatchObject({
      projectKey: 'project-one-from-env-users-alice-work-project-one',
      projectDisplayName: 'Project One alert(1)',
      projectBaseDir: '/Users/alice/work/project-one',
      projectSource: 'env',
      sessionKey: expect.any(String),
      sessionLabel: 'Session 01 alert(1)',
      clientInstanceId: 'client-host.example.com-9123',
    });
    expect(String((written.identity as Record<string, unknown>).sessionKey)).not.toContain('raw-session-id-abcdef1234567890');
    expect(String((written.identity as Record<string, unknown>).sessionKey)).toHaveLength(64);
    expect(String((written.identity as Record<string, unknown>).projectKey)).toMatch(/^[a-z0-9._-]+$/);
    expect(String((written.identity as Record<string, unknown>).projectDisplayName)).not.toMatch(/[<>]/);
    expect(String((written.identity as Record<string, unknown>).sessionLabel)).not.toContain('\n');
  });

  it('readRuntimeProcessInventory preserves safe identity on new records and keeps v1 legacy records valid', () => {
    const runtimeBaseDir = tempDir();
    dirs.push(runtimeBaseDir);
    const stateDir = runtimeProcessStateDir(runtimeBaseDir);
    mkdirSync(stateDir, { recursive: true });

    writeRuntimeRecord(join(stateDir, 'memory-201-identity.json'), {
      schemaVersion: 1,
      id: '6aa7a6a6-1111-4444-8888-000000000001',
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      pid: 201,
      ppid: 1,
      argv: ['node', 'memory.js'],
      cwd: '/Users/alice/work/project-one',
      entrypoint: 'mcp-memory',
      runtimeVersion: '0.0.0-test',
      startedAt: '2026-06-04T09:00:00.000Z',
      lastHeartbeatAt: '2026-06-04T09:00:00.000Z',
      identity: {
        projectKey: 'project-one',
        projectDisplayName: 'Project One',
        projectBaseDir: '/Users/alice/work/project-one',
        projectSource: 'explicit',
        sessionKey: '8ca0f4d9d0d4f3db5d4c2f9a8f6e8d74c8a0f4d9d0d4f3db5d4c2f9a8f6e8d74',
        sessionLabel: 'Session One',
        clientInstanceId: 'client-01',
      },
    });

    writeRuntimeRecord(join(stateDir, 'memory-202-legacy.json'), {
      schemaVersion: 1,
      id: '6aa7a6a6-1111-4444-8888-000000000002',
      role: 'memory',
      serverName: 'byomem-mcp-memory',
      pid: 202,
      ppid: 1,
      argv: ['node', 'memory.js'],
      cwd: '/Users/alice/work/project-two',
      entrypoint: 'mcp-memory',
      runtimeVersion: '0.0.0-test',
      startedAt: '2026-06-04T09:01:00.000Z',
      lastHeartbeatAt: '2026-06-04T09:01:00.000Z',
    });

    const inventory = readRuntimeProcessInventory({
      runtimeBaseDir,
      now: '2026-06-04T09:10:00.000Z',
      processExists: () => true,
    });

    const identityEntry = inventory.records.find((entry) => entry.record.pid === 201);
    const legacyEntry = inventory.records.find((entry) => entry.record.pid === 202);

    expect(inventory.counts).toEqual({ total: 2, active: 2, stale: 0, malformed: 0 });
    expect(identityEntry?.record.schemaVersion).toBe(1);
    expect(identityEntry?.record.identity).toEqual({
      projectKey: 'project-one',
      projectDisplayName: 'Project One',
      projectBaseDir: '/Users/alice/work/project-one',
      projectSource: 'explicit',
      sessionKey: '8ca0f4d9d0d4f3db5d4c2f9a8f6e8d74c8a0f4d9d0d4f3db5d4c2f9a8f6e8d74',
      sessionLabel: 'Session One',
      clientInstanceId: 'client-01',
    });
    expect(legacyEntry?.record.schemaVersion).toBe(1);
    expect(legacyEntry?.record.identity ?? null).toBeNull();
    expect(inventory.malformed).toHaveLength(0);
  });

  it('still parses existing v1 records without identity as valid inventory entries', () => {
    const runtimeBaseDir = tempDir();
    dirs.push(runtimeBaseDir);
    const stateDir = runtimeProcessStateDir(runtimeBaseDir);
    mkdirSync(stateDir, { recursive: true });

    writeRuntimeRecord(join(stateDir, 'readonly-301-legacy.json'), {
      schemaVersion: 1,
      id: '6aa7a6a6-1111-4444-8888-000000000003',
      role: 'readonly',
      serverName: 'byomem-mcp-readonly',
      pid: 301,
      ppid: 1,
      argv: ['node', 'readonly.js'],
      cwd: '/Users/alice/work/project-three',
      entrypoint: 'mcp-readonly',
      runtimeVersion: '0.0.0-test',
      startedAt: '2026-06-04T09:02:00.000Z',
      lastHeartbeatAt: '2026-06-04T09:02:00.000Z',
    });

    const inventory = readRuntimeProcessInventory({
      runtimeBaseDir,
      now: '2026-06-04T09:10:00.000Z',
      processExists: () => true,
    });

    expect(inventory.counts).toEqual({ total: 1, active: 1, stale: 0, malformed: 0 });
    expect(inventory.records[0]?.record.schemaVersion).toBe(1);
    expect(inventory.records[0]?.record.identity ?? null).toBeNull();
    expect(inventory.records[0]?.record.role).toBe('readonly');
  });

  it('does not project raw argv, cwd, env-like values, or raw session ids as identity', () => {
    const runtimeBaseDir = tempDir();
    dirs.push(runtimeBaseDir);

    const registration = registerRuntimeProcess({
      runtimeBaseDir,
      role: 'graph',
      serverName: 'byomem-mcp-graph',
      entrypoint: 'mcp-graph',
      pid: 43210,
      ppid: 1,
      argv: ['node', '/Users/alice/work/project-four/graph.js', '--session-id=raw-session-id-xyz'],
      cwd: '/Users/alice/work/project-four',
      now: '2026-06-04T09:00:00.000Z',
      identity: {
        projectKey: '/Users/alice/work/project-four',
        projectDisplayName: 'graph env value PROJECT_FOUR',
        projectBaseDir: '/Users/alice/work/project-four',
        projectSource: 'env',
        sessionKey: 'raw-session-id-xyz',
        sessionLabel: 'raw-session-id-xyz',
        clientInstanceId: 'PROJECT_FOUR_SESSION_ID=raw-session-id-xyz',
      },
    } as any);

    const written = JSON.parse(readFileSync(registration.path, 'utf8')) as Record<string, unknown>;

    expect(written.identity).toMatchObject({
      projectKey: 'project-four',
      projectDisplayName: 'graph env value project four',
      projectSource: 'env',
    });
    expect(String((written.identity as Record<string, unknown>).sessionKey)).not.toContain('raw-session-id-xyz');
    expect(String((written.identity as Record<string, unknown>).sessionLabel)).not.toContain('raw-session-id-xyz');
    expect(String((written.identity as Record<string, unknown>).clientInstanceId)).not.toContain('raw-session-id-xyz');
    expect(String((written.identity as Record<string, unknown>).projectKey)).not.toContain('/Users/alice/work/project-four');
    expect(String((written.identity as Record<string, unknown>).projectBaseDir)).not.toBe('/Users/alice/work/project-four');
  });

  it('registerMcpRuntimeState derives safe project identity from active project context for grouping', () => {
    const runtimeBaseDir = tempDir();
    const projectDir = join(tempDir(), 'otp-live');
    dirs.push(runtimeBaseDir, projectDir);
    mkdirSync(projectDir, { recursive: true });

    const lifecycle = registerMcpRuntimeState({
      runtimeBaseDir,
      role: 'file-search',
      serverName: 'byomem-mcp-file-search',
      entrypoint: 'mcp-file-search',
      pid: 56789,
      ppid: 12345,
      argv: ['node', '/Users/alice/.codex/secret-session/file-search.js'],
      cwd: projectDir,
      now: '2026-06-04T09:00:00.000Z',
      processExists: () => false,
    });

    const written = JSON.parse(readFileSync(lifecycle.registration.path, 'utf8')) as Record<string, unknown>;

    expect(written.identity).toMatchObject({
      projectKey: 'otp-live',
      projectDisplayName: null,
      projectBaseDir: projectDir,
      projectSource: 'active-project',
    });
    expect(String((written.identity as Record<string, unknown>).projectKey)).not.toContain('/Users/alice');
    expect(String((written.identity as Record<string, unknown>).sessionKey ?? '')).not.toContain('secret-session');
    expect(String((written.identity as Record<string, unknown>).clientInstanceId ?? '')).not.toContain('secret-session');
  });
});
