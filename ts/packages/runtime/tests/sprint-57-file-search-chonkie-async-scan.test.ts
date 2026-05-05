import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSearchScanManager } from '../src/file-search-scan-manager.js';
import type { FileSearchScannerStatus } from '../src/file-search-db.js';

type FileSearchDbHandleLike = {
  scanAndIndexAsync?: (options?: { trigger?: 'open' | 'manual' | 'poll' | 'scheduler-activation' | 'scheduler-post-activity' | 'scheduler-backstop' }) => Promise<FileSearchScannerStatus>;
  getScannerStatus?: () => FileSearchScannerStatus & { chunker?: Record<string, unknown> };
  close(): void;
};

function tempDir(prefix = 'byomem-s57-async-scan-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForJobCompletion(manager: FileSearchScanManager, jobId: string) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const status = manager.getJobStatus(jobId);
    if (status.job?.state === 'completed' || status.job?.state === 'failed') return status;
    await flushMicrotasks();
  }
  return manager.getJobStatus(jobId);
}

function buildCodeFile(projectDir: string): void {
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  writeFileSync(
    join(projectDir, 'src', 'async-ready.ts'),
    [
      'export function alpha() {',
      '  const payload = "alpha".repeat(80);',
      '  return payload.length;',
      '}',
      '',
      'export function beta() {',
      '  const payload = "beta".repeat(80);',
      '  return payload.length;',
      '}',
      '',
      'export function gamma() {',
      '  const payload = "gamma".repeat(80);',
      '  return payload.length;',
      '}',
      '',
      'export function delta() {',
      '  const payload = "delta".repeat(80);',
      '  return payload.length;',
      '}',
      '',
      'export function epsilon() {',
      '  const payload = "epsilon".repeat(80);',
      '  return payload.length;',
      '}',
      '',
      'export function zeta() {',
      '  const payload = "zeta".repeat(80);',
      '  return payload.length;',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
}

const mockState = vi.hoisted(() => {
  function makeReadinessGate() {
    let resolve!: () => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<void>((gateResolve, gateReject) => {
      resolve = gateResolve;
      reject = gateReject;
    });
    return { promise, resolve, reject };
  }

  return {
    chunkCalls: [] as Array<{ filePath: string; contentLength: number }>,
    chunkFileContentError: null as Error | null,
    readiness: makeReadinessGate(),
    reset(): void {
      mockState.chunkCalls.length = 0;
      mockState.chunkFileContentError = null;
      mockState.readiness = makeReadinessGate();
    },
  };
});

vi.mock('../src/file-search-semble.js', async () => {
  const actual = await vi.importActual<typeof import('../src/file-search-semble.js')>('../src/file-search-semble.js');
  return {
    ...actual,
    get chonkieCodeChunkersReady() {
      return mockState.readiness.promise;
    },
    chunkFileContent: ((filePath: string, content: string) => {
      mockState.chunkCalls.push({ filePath, contentLength: content.length });
      if (mockState.chunkFileContentError) throw mockState.chunkFileContentError;
      return actual.chunkFileContent(filePath, content);
    }) as typeof actual.chunkFileContent,
  };
});

describe('Sprint 57 async runtime scan surface', () => {
  const dirs: string[] = [];
  const handles: FileSearchDbHandleLike[] = [];

  afterEach(() => {
    while (handles.length) handles.pop()?.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    mockState.reset();
    vi.restoreAllMocks();
  });

  async function openHarness(projectDir: string) {
    const runtime = await import('../src/index.js');
    const fileDb = runtime.openFileSearchDb({
      baseDir: projectDir,
      scanOnOpen: false,
      schedulerEnabled: false,
      semanticSearchEnabled: false,
      scannerIncludeTextFiles: true,
    }) as FileSearchDbHandleLike;
    const projectKey = runtime.resolveFileSearchProjectKey(projectDir);
    const manager = new FileSearchScanManager({
      scanRunner: async (request) => {
        const asyncScan = fileDb.scanAndIndexAsync;
        expect(asyncScan, 'runtime-local async scan path must exist').toEqual(expect.any(Function));
        return asyncScan!({ trigger: request.trigger });
      },
      statusReader: () => fileDb.getScannerStatus?.(),
      scheduler: (callback) => callback(),
    });
    handles.push(fileDb);
    return { fileDb, manager, projectKey };
  }

  it('waits for Chonkie readiness before chunking code files in a runtime-local async scan job and surfaces chunker diagnostics', async () => {
    const projectDir = tempDir();
    dirs.push(projectDir);
    buildCodeFile(projectDir);

    const { manager, projectKey } = await openHarness(projectDir);
    const job = manager.enqueueScan({ projectKey, baseDir: projectDir, trigger: 'manual' });

    await flushMicrotasks();
    expect(mockState.chunkCalls).toHaveLength(0);
    expect(manager.getJobStatus(job.job_id).job?.state).toBe('running');

    mockState.readiness.resolve();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(mockState.chunkCalls.length).toBeGreaterThan(0);
    const completed = await waitForJobCompletion(manager, job.job_id);
    expect(completed.job?.state).toBe('completed');
    expect(completed.job?.scanner).toEqual(expect.objectContaining({
      state: 'completed',
      chunker: expect.objectContaining({
        source: expect.any(String),
        waitedForReadiness: true,
      }),
    }));
  });

  it('treats a failed Chonkie initialization as fallback diagnostics instead of failing the runtime-local async job', async () => {
    const projectDir = tempDir();
    dirs.push(projectDir);
    buildCodeFile(projectDir);

    const { manager, projectKey } = await openHarness(projectDir);
    const job = manager.enqueueScan({ projectKey, baseDir: projectDir, trigger: 'manual' });

    await flushMicrotasks();
    expect(mockState.chunkCalls).toHaveLength(0);

    mockState.chunkFileContentError = new Error('chonkie initialization failed');
    mockState.readiness.resolve();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(mockState.chunkCalls.length).toBeGreaterThan(0);
    const completed = await waitForJobCompletion(manager, job.job_id);
    expect(completed.job?.state).toBe('completed');
    expect(completed.job?.error).toBeNull();
    expect(completed.job?.scanner).toEqual(expect.objectContaining({
      state: 'completed',
      chunker: expect.objectContaining({
        source: 'line-fallback',
        fallbackReason: 'chunker-error',
      }),
    }));
  });

  it('preserves Sprint 43 same-project duplicate and cross-project concurrency behavior', async () => {
    const firstProject = tempDir();
    const secondProject = tempDir();
    dirs.push(firstProject, secondProject);

    const firstGate = deferred<FileSearchScannerStatus>();
    const secondGate = deferred<FileSearchScannerStatus>();
    const starts: string[] = [];
    const manager = new FileSearchScanManager({
      scanRunner: (request) => {
        starts.push(request.projectKey);
        return request.projectKey === 'project:async-a' ? firstGate.promise : secondGate.promise;
      },
      scheduler: (callback) => callback(),
    });

    const first = manager.enqueueScan({ projectKey: 'project:async-a', baseDir: firstProject });
    const duplicate = manager.enqueueScan({ projectKey: 'project:async-a', baseDir: firstProject });
    const second = manager.enqueueScan({ projectKey: 'project:async-b', baseDir: secondProject });

    expect(duplicate.job_id).toBe(first.job_id);
    await flushMicrotasks();
    expect(starts).toEqual(['project:async-a']);
    expect(manager.getJobStatus(second.job_id).job?.state).toBe('queued');

    firstGate.resolve({
      state: 'completed',
      projectKey: 'project:async-a',
      baseDir: firstProject,
      polling_enabled: false,
      poll_interval_seconds: null,
      last_poll_at: null,
      next_poll_at: null,
      consecutive_no_change_polls: 0,
      idle_disable_after_polls: null,
      polling_disabled_reason: 'default-off',
      last_scan_at: null,
      trigger: 'manual',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      progress: {
        discoveredFiles: 1,
        scannedFiles: 1,
        indexedFiles: 1,
        unchangedFiles: 0,
        changedFiles: 1,
        deletedFiles: 0,
        ignoredFiles: 0,
        errorFiles: 0,
        chunksWritten: 1,
        filesRemaining: 0,
      },
      database: { indexedFiles: 1, indexedChunks: 1, changedRows: 0, reconciledRows: 0 },
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(starts).toEqual(['project:async-a', 'project:async-b']);
    secondGate.resolve({
      state: 'completed',
      projectKey: 'project:async-b',
      baseDir: secondProject,
      polling_enabled: false,
      poll_interval_seconds: null,
      last_poll_at: null,
      next_poll_at: null,
      consecutive_no_change_polls: 0,
      idle_disable_after_polls: null,
      polling_disabled_reason: 'default-off',
      last_scan_at: null,
      trigger: 'manual',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      progress: {
        discoveredFiles: 1,
        scannedFiles: 1,
        indexedFiles: 1,
        unchangedFiles: 0,
        changedFiles: 1,
        deletedFiles: 0,
        ignoredFiles: 0,
        errorFiles: 0,
        chunksWritten: 1,
        filesRemaining: 0,
      },
      database: { indexedFiles: 1, indexedChunks: 1, changedRows: 0, reconciledRows: 0 },
    });
  });
});
