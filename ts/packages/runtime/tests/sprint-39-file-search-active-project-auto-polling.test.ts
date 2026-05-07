import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { main } from '../src/cli.js';
import { openFileSearchDb } from '../src/file-search-db.js';
import { listFileSearchProjects, registerFileSearchProject } from '../src/file-search-project-registry.js';

type RegisteredTool = {
  name: string;
  parameters?: unknown;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown> | unknown;
};

type MockPi = ReturnType<typeof makeMockPi>;

function tempDir(prefix = 'byomem-s39-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeMockPi() {
  const tools: RegisteredTool[] = [];
  const events: Record<string, Array<(...args: any[]) => any>> = {};
  return {
    tools,
    events,
    api: {
      on(name: string, handler: (...args: any[]) => any) {
        events[name] ??= [];
        events[name].push(handler);
      },
      registerTool(tool: RegisteredTool) {
        tools.push(tool);
      },
      registerCommand() {},
    },
  };
}

type PiExtensionModule = typeof import('../src/pi-extension.ts');
let extensionModule: PiExtensionModule | undefined;

async function loadExtension(): Promise<PiExtensionModule> {
  extensionModule ??= await import('../src/pi-extension.ts');
  extensionModule.byomem_runtime_test_reload_env();
  return extensionModule;
}

function tool(mock: MockPi, name: string): RegisteredTool {
  const found = mock.tools.find((candidate) => candidate.name === name);
  expect(found, `expected Pi tool ${name} to be registered`).toBeDefined();
  if (!found) throw new Error(`missing Pi tool ${name}`);
  return found;
}

function lastJson(spy: ReturnType<typeof vi.spyOn<typeof console, 'log'>>): any {
  return JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'));
}

function pollingFields(extra: Record<string, unknown> = {}) {
  return expect.objectContaining({
    polling_enabled: false,
    poll_interval_seconds: null,
    last_poll_at: null,
    next_poll_at: null,
    last_scan_at: null,
    consecutive_no_change_polls: 0,
    idle_disable_after_polls: null,
    polling_disabled_reason: 'default-off',
    ...extra,
  });
}

describe('Sprint 39 active-project file-search auto polling RED contract', () => {
  const dirs: string[] = [];
  const mocks: MockPi[] = [];
  const originalRuntimeBase = process.env.BYOMEM_RUNTIME_BASE_DIR;
  const originalCwd = process.cwd;

  afterEach(async () => {
    while (mocks.length) {
      const mock = mocks.pop()!;
      const cleanupHandlers = [
        ...(mock.events.dispose ?? []),
        ...(mock.events.shutdown ?? []),
        ...(mock.events['runtime:end'] ?? []),
        ...(mock.events['session:end'] ?? []),
      ];
      for (const handler of cleanupHandlers) await handler({}, {});
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.cwd = originalCwd;
    if (originalRuntimeBase === undefined) delete process.env.BYOMEM_RUNTIME_BASE_DIR;
    else process.env.BYOMEM_RUNTIME_BASE_DIR = originalRuntimeBase;
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  function trackedTemp(prefix?: string): string {
    const dir = tempDir(prefix);
    dirs.push(dir);
    return dir;
  }

  function trackedMockPi(): MockPi {
    const mock = makeMockPi();
    mocks.push(mock);
    return mock;
  }

  function setRuntime(): string {
    const runtimeDir = trackedTemp('byomem-s39-runtime-');
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    return runtimeDir;
  }

  it('does not create a default/global polling timer when the extension/runtime loads', async () => {
    vi.useFakeTimers();
    const runtimeDir = setRuntime();
    const projectDir = trackedTemp('byomem-s39-default-off-');
    writeFileSync(join(projectDir, 'a.txt'), 'alpha\n', 'utf8');
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    const mod = await loadExtension();
    const mock = trackedMockPi();
    mod.default(mock.api as never);
    const fileDb = openFileSearchDb({ baseDir: projectDir, scanOnOpen: false, schedulerEnabled: false });
    try {
      expect(fileDb.path).toBe(resolve(runtimeDir, 'byomem-file-search.sqlite'));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      fileDb.close();
    }
  });

  it('exposes disabled polling status fields without starting polling', async () => {
    vi.useFakeTimers();
    setRuntime();
    const projectDir = trackedTemp('byomem-s39-status-');
    writeFileSync(join(projectDir, 'status.txt'), 'status body\n', 'utf8');
    const mod = await loadExtension();
    const mock = trackedMockPi();
    mod.default(mock.api as never);

    const status = await tool(mock, 'byomem_file_search_polling_status').execute('status-1', { baseDir: projectDir }) as Record<string, any>;

    expect(status).toMatchObject({ polling: pollingFields(), status: pollingFields() });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('registers explicit polling-only Pi tools and leaves existing search/status/scan tools non-polling', async () => {
    const mod = await loadExtension();
    const mock = trackedMockPi();
    mod.default(mock.api as never);

    expect(mock.tools.map((entry) => entry.name)).toEqual(expect.arrayContaining([
      'byomem_file_search',
      'byomem_file_search_status',
      'byomem_file_search_scan',
      'byomem_file_search_project_register',
      'byomem_file_search_project_list',
      'byomem_file_search_project_unregister',
      'byomem_file_search_polling_status',
      'byomem_file_search_polling_enable',
      'byomem_file_search_polling_disable',
    ]));
    expect(tool(mock, 'byomem_file_search_polling_enable').parameters).toEqual({
      type: 'object',
      properties: {
        baseDir: { type: 'string' },
        pollIntervalSeconds: { type: 'integer', minimum: 1 },
        idleDisableAfterPolls: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    });
    expect(tool(mock, 'byomem_file_search_polling_status').parameters).toEqual({
      type: 'object',
      properties: { baseDir: { type: 'string' } },
      additionalProperties: false,
    });
    expect(tool(mock, 'byomem_file_search_polling_disable').parameters).toEqual({
      type: 'object',
      properties: { baseDir: { type: 'string' }, reason: { type: 'string' } },
      additionalProperties: false,
    });
  });

  it('explicit enable defaults to the active project only and does not poll a second registered project', async () => {
    vi.useFakeTimers();
    setRuntime();
    const activeDir = trackedTemp('byomem-s39-active-');
    const otherDir = trackedTemp('byomem-s39-other-');
    writeFileSync(join(activeDir, 'active.txt'), 'active\n', 'utf8');
    writeFileSync(join(otherDir, 'other.txt'), 'other\n', 'utf8');
    vi.spyOn(process, 'cwd').mockReturnValue(activeDir);

    const seedDb = openFileSearchDb({ baseDir: activeDir, scanOnOpen: false, schedulerEnabled: false });
    try {
      registerFileSearchProject(seedDb.db, activeDir);
      registerFileSearchProject(seedDb.db, otherDir);
    } finally {
      seedDb.close();
    }

    const mod = await loadExtension();
    const mock = trackedMockPi();
    mod.default(mock.api as never);

    const enabled = await tool(mock, 'byomem_file_search_polling_enable').execute('enable-1', {
      pollIntervalSeconds: 2,
      idleDisableAfterPolls: 5,
    }) as Record<string, any>;
    const otherStatus = await tool(mock, 'byomem_file_search_polling_status').execute('status-other', { baseDir: otherDir }) as Record<string, any>;

    expect(enabled).toMatchObject({
      polling: expect.objectContaining({
        base_dir: resolve(activeDir),
        polling_enabled: true,
        poll_interval_seconds: 2,
        idle_disable_after_polls: 5,
        consecutive_no_change_polls: 0,
        polling_disabled_reason: null,
      }),
    });
    expect(otherStatus).toMatchObject({ polling: pollingFields({ polling_disabled_reason: 'default-off' }) });
    expect(vi.getTimerCount()).toBe(1);
  });

  it('rejects omitted or mismatched active-project resolution fail-closed with deterministic reasons', async () => {
    setRuntime();
    const activeDir = trackedTemp('byomem-s39-active-match-');
    const otherDir = trackedTemp('byomem-s39-active-mismatch-');
    vi.spyOn(process, 'cwd').mockReturnValue(activeDir);
    const mod = await loadExtension();
    const mock = trackedMockPi();
    mod.default(mock.api as never);

    await expect(tool(mock, 'byomem_file_search_polling_enable').execute('mismatch', {
      baseDir: otherDir,
      pollIntervalSeconds: 2,
      idleDisableAfterPolls: 2,
    })).rejects.toThrow(/not-active-project/i);

    vi.spyOn(process, 'cwd').mockReturnValue('');
    await expect(tool(mock, 'byomem_file_search_polling_enable').execute('no-active', {
      pollIntervalSeconds: 2,
      idleDisableAfterPolls: 2,
    })).rejects.toThrow(/no-active-project/i);
  });

  it('uses configurable poll interval for timer ticks and updates last_poll_at, next_poll_at, and last_scan_at', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-26T10:00:00.000Z'));
    setRuntime();
    const projectDir = trackedTemp('byomem-s39-interval-');
    writeFileSync(join(projectDir, 'interval.txt'), 'interval v1\n', 'utf8');
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    const mod = await loadExtension();
    const mock = trackedMockPi();
    mod.default(mock.api as never);

    await tool(mock, 'byomem_file_search_polling_enable').execute('enable-interval', {
      pollIntervalSeconds: 3,
      idleDisableAfterPolls: 10,
    });
    vi.advanceTimersByTime(2_999);
    let status = await tool(mock, 'byomem_file_search_polling_status').execute('status-before', {}) as Record<string, any>;
    expect(status.polling.last_poll_at).toBeNull();
    vi.advanceTimersByTime(1);
    status = await tool(mock, 'byomem_file_search_polling_status').execute('status-after', {}) as Record<string, any>;

    expect(status.polling).toMatchObject({
      polling_enabled: true,
      poll_interval_seconds: 3,
      last_poll_at: '2026-04-26T10:00:03.000Z',
      next_poll_at: '2026-04-26T10:00:06.000Z',
      last_scan_at: expect.any(String),
    });
    expect(new Date(status.polling.last_scan_at).toString()).not.toBe('Invalid Date');
  });

  it('increments no-change polls, resets on file change, then idle-disables and stops future scans', async () => {
    vi.useFakeTimers();
    setRuntime();
    const projectDir = trackedTemp('byomem-s39-idle-');
    const filePath = join(projectDir, 'idle.txt');
    writeFileSync(filePath, 'idle v1\n', 'utf8');
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    const mod = await loadExtension();
    const mock = trackedMockPi();
    mod.default(mock.api as never);

    await tool(mock, 'byomem_file_search_polling_enable').execute('enable-idle', {
      pollIntervalSeconds: 1,
      idleDisableAfterPolls: 2,
    });
    vi.advanceTimersByTime(1_000);
    let status = await tool(mock, 'byomem_file_search_polling_status').execute('status-no-change-1', {}) as Record<string, any>;
    expect(status.polling.consecutive_no_change_polls).toBe(1);

    writeFileSync(filePath, 'idle v2 changed\n', 'utf8');
    vi.advanceTimersByTime(1_000);
    status = await tool(mock, 'byomem_file_search_polling_status').execute('status-changed', {}) as Record<string, any>;
    expect(status.polling.consecutive_no_change_polls).toBe(0);

    vi.advanceTimersByTime(2_000);
    status = await tool(mock, 'byomem_file_search_polling_status').execute('status-idle-off', {}) as Record<string, any>;
    const lastPollAt = status.polling.last_poll_at;
    expect(status.polling).toMatchObject({
      polling_enabled: false,
      consecutive_no_change_polls: 2,
      next_poll_at: null,
      polling_disabled_reason: 'idle-no-changes',
    });
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(10_000);
    status = await tool(mock, 'byomem_file_search_polling_status').execute('status-no-further-polls', {}) as Record<string, any>;
    expect(status.polling.last_poll_at).toBe(lastPollAt);
  });

  it('poll failures disable polling with poll-error without incrementing no-change counters', async () => {
    vi.useFakeTimers();
    setRuntime();
    const projectDir = trackedTemp('byomem-s39-poll-error-');
    const filePath = join(projectDir, 'unreadable.txt');
    writeFileSync(filePath, 'readable baseline\n', 'utf8');
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    const mod = await loadExtension();
    const mock = trackedMockPi();
    mod.default(mock.api as never);

    await tool(mock, 'byomem_file_search_polling_enable').execute('enable-poll-error', {
      pollIntervalSeconds: 1,
      idleDisableAfterPolls: 2,
    });
    chmodSync(filePath, 0o000);
    try {
      vi.advanceTimersByTime(1_000);
      const status = await tool(mock, 'byomem_file_search_polling_status').execute('status-poll-error', {}) as Record<string, any>;
      expect(status.polling).toMatchObject({
        polling_enabled: false,
        consecutive_no_change_polls: 0,
        next_poll_at: null,
        polling_disabled_reason: 'poll-error',
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      chmodSync(filePath, 0o600);
    }
  });

  it('explicit disable clears the timer, clears next_poll_at, and records manually-disabled', async () => {
    vi.useFakeTimers();
    setRuntime();
    const projectDir = trackedTemp('byomem-s39-disable-');
    writeFileSync(join(projectDir, 'disable.txt'), 'disable\n', 'utf8');
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    const mod = await loadExtension();
    const mock = trackedMockPi();
    mod.default(mock.api as never);

    await tool(mock, 'byomem_file_search_polling_enable').execute('enable-disable', {
      pollIntervalSeconds: 5,
      idleDisableAfterPolls: 10,
    });
    const disabled = await tool(mock, 'byomem_file_search_polling_disable').execute('disable', {}) as Record<string, any>;

    expect(disabled.polling).toMatchObject({
      polling_enabled: false,
      next_poll_at: null,
      polling_disabled_reason: 'manually-disabled',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('session/runtime cleanup clears polling state and prevents further scans', async () => {
    vi.useFakeTimers();
    setRuntime();
    const projectDir = trackedTemp('byomem-s39-session-end-');
    writeFileSync(join(projectDir, 'session.txt'), 'session\n', 'utf8');
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);
    const mod = await loadExtension();
    const mock = trackedMockPi();
    mod.default(mock.api as never);

    await tool(mock, 'byomem_file_search_polling_enable').execute('enable-session', {
      pollIntervalSeconds: 1,
      idleDisableAfterPolls: 10,
    });
    const cleanupHandlers = [
      ...(mock.events.dispose ?? []),
      ...(mock.events.shutdown ?? []),
      ...(mock.events['runtime:end'] ?? []),
      ...(mock.events['session:end'] ?? []),
    ];
    expect(cleanupHandlers.length, 'extension must register deterministic polling cleanup on session/runtime end').toBeGreaterThan(0);
    for (const handler of cleanupHandlers) await handler({}, {});

    const status = await tool(mock, 'byomem_file_search_polling_status').execute('status-session-ended', {}) as Record<string, any>;
    expect(status.polling).toMatchObject({
      polling_enabled: false,
      next_poll_at: null,
      polling_disabled_reason: 'session-ended',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('existing search/status/scan/registry paths do not start polling or mutate counters', async () => {
    vi.useFakeTimers();
    setRuntime();
    const projectDir = trackedTemp('byomem-s39-existing-paths-');
    writeFileSync(join(projectDir, 'needle.txt'), 'needle existing paths\n', 'utf8');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await main(['file-search-status', '--base-dir', projectDir, '--json']);
    expect(lastJson(logSpy).status).toEqual(expect.not.objectContaining({ polling_enabled: true }));
    await main(['file-search-scan', '--base-dir', projectDir, '--json']);
    await main(['file-search', '--base-dir', projectDir, '--query', 'needle', '--mode', 'bm25', '--json']);
    await main(['file-search-project-register', '--base-dir', projectDir, '--json']);
    await main(['file-search-project-list', '--base-dir', projectDir, '--json']);

    const fileDb = openFileSearchDb({ baseDir: projectDir, scanOnOpen: false, schedulerEnabled: false });
    try {
      expect(vi.getTimerCount()).toBe(0);
      expect(listFileSearchProjects(fileDb.db)).toEqual([
        expect.objectContaining({
          baseDir: resolve(projectDir),
          pollingEnabled: false,
          consecutiveNoChangePolls: 0,
          lastPollAt: undefined,
          nextPollAt: undefined,
          pollingDisabledReason: 'default-off',
        }),
      ]);
    } finally {
      fileDb.close();
    }
  });

  it('CLI polling commands require explicit --base-dir, validate config, and report stable JSON fields', async () => {
    vi.useFakeTimers();
    setRuntime();
    const projectDir = trackedTemp('byomem-s39-cli-');
    writeFileSync(join(projectDir, 'cli.txt'), 'cli polling\n', 'utf8');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await main(['file-search-polling-status', '--json']);
    expect(errorSpy.mock.calls.at(-1)?.[0]).toMatch(/base-dir/i);
    process.exitCode = undefined;
    await main(['file-search-polling-enable', '--base-dir', projectDir, '--poll-interval-seconds', '0', '--idle-disable-after-polls', '2', '--json']);
    expect(errorSpy.mock.calls.at(-1)?.[0]).toMatch(/poll-interval-seconds/i);
    process.exitCode = undefined;
    await main(['file-search-polling-enable', '--base-dir', projectDir, '--poll-interval-seconds', '2', '--idle-disable-after-polls', '3', '--json']);
    expect(lastJson(logSpy)).toMatchObject({
      polling: expect.objectContaining({
        base_dir: resolve(projectDir),
        polling_enabled: true,
        poll_interval_seconds: 2,
        idle_disable_after_polls: 3,
      }),
    });
    await main(['file-search-polling-disable', '--base-dir', projectDir, '--json']);
    expect(lastJson(logSpy)).toMatchObject({ polling: expect.objectContaining({ polling_enabled: false, polling_disabled_reason: 'manually-disabled', next_poll_at: null }) });
  });
});
