import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openFileSearchDb } from '../src/file-search-db.js';
import { disposeMockPi, loadExtension, makeMockPi, requireRegisteredTool, tempDir, type MockPi } from './helpers/pi-extension-test-utils.js';

describe('Sprint 38 file-search extension direct scan contract', () => {
  const dirs: string[] = [];
  const mocks: MockPi[] = [];
  const originalFetch = globalThis.fetch;

  afterEach(async () => {
    while (mocks.length) {
      await disposeMockPi(mocks.pop()!);
    }
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    globalThis.fetch = originalFetch;
    process.exitCode = undefined;
  });

  function trackedTemp(prefix?: string): string {
    const dir = tempDir(prefix);
    dirs.push(dir);
    return dir;
  }

  function trackedConfig(prefix: string, content = ''): string {
    const configDir = trackedTemp(prefix);
    const configPath = join(configDir, 'config.yaml');
    writeFileSync(configPath, content, 'utf8');
    vi.stubEnv('BYOMEM_CONFIG_PATH', configPath);
    return configPath;
  }

  function mockFetchForbid(message: string): void {
    globalThis.fetch = vi.fn(async () => {
      throw new Error(message);
    }) as unknown as typeof fetch;
  }

  function trackedMockPi(): MockPi {
    const mock = makeMockPi();
    mocks.push(mock);
    return mock;
  }

  it('returns scanner status and manual scan shapes without scheduler timers or scan side effects from status', async () => {
    vi.useFakeTimers();
    trackedConfig('byomem-s38-status-config-');
    mockFetchForbid('file-search status/scan must not request embeddings');
    const projectDir = trackedTemp('byomem-s38-status-');
    const runtimeDir = trackedTemp('byomem-s38-status-runtime-');
    writeFileSync(join(projectDir, 'status.txt'), 'status body\n', 'utf8');
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', runtimeDir);

    const mod = await loadExtension();
    const mock = trackedMockPi();
    mod.default(mock.api as never);

    const statusTool = requireRegisteredTool(mock, 'byomem_file_search_status');
    const scanTool = requireRegisteredTool(mock, 'byomem_file_search_scan');

    const status = await statusTool.execute('1', { baseDir: projectDir }) as { scanner?: Record<string, unknown>; status?: Record<string, unknown> };
    expect(status).toMatchObject({ scanner: expect.any(Object), status: expect.any(Object) });
    expect(status.status).not.toHaveProperty('database.projects');
    expect(status.scanner).not.toHaveProperty('database.projects');
    expect(existsSync(join(projectDir, 'native-store.json'))).toBe(false);

    const scan = await scanTool.execute('2', { baseDir: projectDir }) as { scanner?: Record<string, unknown>; status?: Record<string, unknown> };
    expect(scan).toMatchObject({ scanner: expect.any(Object), status: expect.any(Object) });
    expect(scan.status).not.toHaveProperty('database.projects');
    expect(scan.scanner).not.toHaveProperty('database.projects');
  });

  it('refreshes direct Pi scan embeddings with the configured backend identity', async () => {
    trackedConfig('byomem-s38-scan-embedding-config-');
    const projectDir = trackedTemp('byomem-s38-scan-embedding-');
    const runtimeDir = trackedTemp('byomem-s38-scan-embedding-runtime-');
    writeFileSync(join(projectDir, 'semantic.txt'), 'semantic alpha target body\n', 'utf8');
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', runtimeDir);
    vi.stubEnv('BYOMEM_FILE_SEARCH_INCLUDE_TEXT_FILES', 'true');
    vi.stubEnv('BYOMEM_EMBEDDING_BASE_URL', 'http://localhost:11434');
    vi.stubEnv('BYOMEM_EMBEDDING_MODEL', 'pi-direct-mock-model');
    vi.stubEnv('BYOMEM_EMBEDDING_DIMENSION', '3');

    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ embedding: [1, 0, 0] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const mod = await loadExtension();
    const mock = trackedMockPi();
    mod.default(mock.api as never);

    const scanTool = requireRegisteredTool(mock, 'byomem_file_search_scan');
    const scan = await scanTool.execute('1', { baseDir: projectDir }) as {
      refresh?: { automatic?: boolean; attempted?: boolean };
      embeddings?: { state?: string; model?: string; configuredDimension?: number; refreshNeededChunks?: number };
    };

    expect(scan.refresh).toMatchObject({ automatic: true, attempted: true });
    expect(scan.embeddings).toMatchObject({
      state: 'ready',
      model: 'pi-direct-mock-model',
      configuredDimension: 3,
      refreshNeededChunks: 0,
    });
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('supports explicit runtime-local async scan enqueue and status lookup without changing default scan behavior', async () => {
    trackedConfig('byomem-s38-async-config-');
    mockFetchForbid('file-search async scan must not request embeddings');
    const projectDir = trackedTemp('byomem-s38-s43-async-');
    const runtimeDir = trackedTemp('byomem-s38-s43-runtime-');
    writeFileSync(join(projectDir, 'async.txt'), 'async body\n', 'utf8');
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', runtimeDir);
    vi.stubEnv('BYOMEM_FILE_SEARCH_INCLUDE_TEXT_FILES', 'true');

    const mod = await loadExtension();
    const mock = trackedMockPi();
    mod.default(mock.api as never);

    const scanTool = requireRegisteredTool(mock, 'byomem_file_search_scan');
    const statusTool = requireRegisteredTool(mock, 'byomem_file_search_status');

    const enqueue = await scanTool.execute('1', { baseDir: projectDir, async: true }) as {
      job?: { job_id?: string; state?: string; durable?: boolean };
      scanner?: { state?: string } | null;
      runtime_local?: boolean;
      durable?: boolean;
    };
    expect(enqueue).toMatchObject({
      runtime_local: true,
      durable: false,
      job: { job_id: expect.stringMatching(/^runtime-scan-/), state: 'queued', durable: false },
    });

    const byJob = await statusTool.execute('2', { jobId: enqueue.job?.job_id }) as {
      job_status?: { found?: boolean };
      job?: { job_id?: string };
    };
    expect(byJob).toMatchObject({ job_status: { found: true }, job: { job_id: enqueue.job?.job_id } });

    await new Promise((resolve) => setTimeout(resolve, 10));
    const completed = await statusTool.execute('3', { jobId: enqueue.job?.job_id }) as {
      job?: { state?: string; scanner?: { state?: string; database?: { indexedFiles?: number } } };
    };
    expect(['running', 'completed']).toContain(completed.job?.state);
    if (completed.job?.state === 'completed') {
      expect(completed.job.scanner).toMatchObject({ state: 'completed', database: expect.objectContaining({ indexedFiles: 1 }) });
    }
  }, 10_000);

  it('skips default database extensions and binary content through the direct Pi scan tool', async () => {
    trackedConfig('byomem-s38-binary-config-');
    mockFetchForbid('file-search binary scan must not request embeddings');
    const projectDir = trackedTemp('byomem-s38-scan-');
    const runtimeDir = trackedTemp('byomem-s38-scan-runtime-');
    writeFileSync(join(projectDir, 'keep.txt'), 'keep body\n', 'utf8');
    writeFileSync(join(projectDir, 'artifact.db'), 'artifact body\n', 'utf8');
    writeFileSync(join(projectDir, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0x61, 0x62, 0x63]));
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', runtimeDir);
    vi.stubEnv('BYOMEM_FILE_SEARCH_INCLUDE_TEXT_FILES', 'true');

    const mod = await loadExtension();
    const mock = trackedMockPi();
    mod.default(mock.api as never);

    const scanTool = requireRegisteredTool(mock, 'byomem_file_search_scan');
    const result = await scanTool.execute('1', { baseDir: projectDir }) as { scanner?: { progress?: { ignoredFiles?: number; errorFiles?: number } } };

    const fileDb = openFileSearchDb({
      baseDir: projectDir,
      dbBaseDir: runtimeDir,
      scanOnOpen: false,
      schedulerEnabled: false,
      semanticSearchEnabled: false,
      scannerIncludeTextFiles: true,
    });
    try {
      const indexedPaths = (fileDb.db.prepare('SELECT path FROM indexed_files ORDER BY path').all() as Array<{ path: string }>).map((row) => row.path);
      expect(indexedPaths).toEqual([join(projectDir, 'keep.txt')]);
      expect(result.scanner?.progress).toMatchObject({ ignoredFiles: expect.any(Number), errorFiles: 0 });
      expect(result.scanner?.progress?.ignoredFiles).toBeGreaterThanOrEqual(2);
    } finally {
      fileDb.close();
    }
  }, 15_000);
});
