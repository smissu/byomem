import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { FileSearchScanManager, type FileSearchAsyncScanRequest, type FileSearchScannerStatus, openFileSearchDb } from '../src/index.js';

function tempDir(prefix = 'byomem-s43-'): string {
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

function scannerStatus(projectKey: string, baseDir: string, state: FileSearchScannerStatus['state'] = 'completed'): FileSearchScannerStatus {
  return {
    state,
    projectKey,
    baseDir,
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
    completedAt: state === 'running' ? undefined : new Date().toISOString(),
    progress: {
      discoveredFiles: 1,
      scannedFiles: 1,
      indexedFiles: state === 'completed' ? 1 : 0,
      unchangedFiles: 0,
      changedFiles: state === 'completed' ? 1 : 0,
      deletedFiles: 0,
      ignoredFiles: 0,
      errorFiles: state === 'failed' ? 1 : 0,
      chunksWritten: state === 'completed' ? 1 : 0,
      filesRemaining: 0,
    },
    database: { indexedFiles: state === 'completed' ? 1 : 0, indexedChunks: state === 'completed' ? 1 : 0, changedRows: 0, reconciledRows: 0 },
  };
}

async function nextTick(): Promise<void> {
  await new Promise((resolveNext) => setTimeout(resolveNext, 0));
}

describe('Sprint 43 runtime-local file-search async scan jobs', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns a runtime-local job id before the scan runner completes and supports status by job id', async () => {
    const projectDir = tempDir();
    dirs.push(projectDir);
    const gate = deferred<FileSearchScannerStatus>();
    const started: FileSearchAsyncScanRequest[] = [];
    const manager = new FileSearchScanManager({
      scanRunner: (request) => {
        started.push(request);
        return gate.promise;
      },
      statusReader: (request) => scannerStatus(request.projectKey, request.baseDir, 'running'),
    });

    const job = manager.enqueueScan({ projectKey: 'project:s43-a', baseDir: projectDir, trigger: 'manual' });

    expect(job).toMatchObject({
      job_id: expect.stringMatching(/^runtime-scan-/),
      project_key: 'project:s43-a',
      base_dir: resolve(projectDir),
      state: 'queued',
      durable: false,
      error: null,
    });
    expect(started).toHaveLength(0);

    await nextTick();
    expect(started).toHaveLength(1);
    expect(manager.getJobStatus(job.job_id)).toMatchObject({ found: true, runtime_local: true, durable: false, job: { state: 'running', scanner: { state: 'running' } } });

    gate.resolve(scannerStatus('project:s43-a', resolve(projectDir), 'completed'));
    await nextTick();

    expect(manager.getJobStatus(job.job_id)).toMatchObject({
      found: true,
      job: { job_id: job.job_id, state: 'completed', completed_at: expect.any(String), error: null, scanner: { state: 'completed' } },
    });
  });

  it('returns the active same-project job id instead of starting a duplicate scan', async () => {
    const projectDir = tempDir();
    dirs.push(projectDir);
    const gate = deferred<FileSearchScannerStatus>();
    const runner = vi.fn(() => gate.promise);
    const manager = new FileSearchScanManager({ scanRunner: runner });

    const first = manager.enqueueScan({ projectKey: 'project:same', baseDir: projectDir });
    const second = manager.enqueueScan({ projectKey: 'project:same', baseDir: projectDir });

    expect(second.job_id).toBe(first.job_id);
    await nextTick();
    expect(runner).toHaveBeenCalledTimes(1);
    gate.resolve(scannerStatus('project:same', resolve(projectDir), 'completed'));
  });

  it('serializes different-project async scans with default concurrency one', async () => {
    const projectA = tempDir();
    const projectB = tempDir();
    dirs.push(projectA, projectB);
    const firstGate = deferred<FileSearchScannerStatus>();
    const secondGate = deferred<FileSearchScannerStatus>();
    const starts: string[] = [];
    const manager = new FileSearchScanManager({
      scanRunner: (request) => {
        starts.push(request.projectKey);
        return request.projectKey === 'project:a' ? firstGate.promise : secondGate.promise;
      },
    });

    const first = manager.enqueueScan({ projectKey: 'project:a', baseDir: projectA });
    const second = manager.enqueueScan({ projectKey: 'project:b', baseDir: projectB });

    expect(first.job_id).not.toBe(second.job_id);
    await nextTick();
    expect(starts).toEqual(['project:a']);
    expect(manager.getJobStatus(second.job_id).job?.state).toBe('queued');

    firstGate.resolve(scannerStatus('project:a', resolve(projectA), 'completed'));
    await nextTick();
    await nextTick();
    expect(starts).toEqual(['project:a', 'project:b']);
    secondGate.resolve(scannerStatus('project:b', resolve(projectB), 'completed'));
  });

  it('allows terminal jobs to be superseded and retains failed-job diagnostics', async () => {
    const projectDir = tempDir();
    dirs.push(projectDir);
    let shouldFail = true;
    const manager = new FileSearchScanManager({
      scanRunner: (request) => {
        if (shouldFail) throw new Error('scan exploded');
        return scannerStatus(request.projectKey, request.baseDir, 'completed');
      },
    });

    const failed = manager.enqueueScan({ projectKey: 'project:terminal', baseDir: projectDir });
    await nextTick();
    await nextTick();
    expect(manager.getJobStatus(failed.job_id)).toMatchObject({ found: true, job: { state: 'failed', error: 'scan exploded' } });

    shouldFail = false;
    const replacement = manager.enqueueScan({ projectKey: 'project:terminal', baseDir: projectDir });
    expect(replacement.job_id).not.toBe(failed.job_id);
    await nextTick();
    await nextTick();
    expect(manager.getJobStatus(replacement.job_id)).toMatchObject({ found: true, job: { state: 'completed', error: null } });
    expect(manager.getJobStatus('runtime-scan-does-not-exist')).toMatchObject({ found: false, runtime_local: true, durable: false, error: 'runtime-local-job-not-found', job: null });
  });

  it('preserves the existing synchronous scanAndIndex contract', () => {
    const projectDir = tempDir();
    dirs.push(projectDir);
    writeFileSync(join(projectDir, 'sync.txt'), 'sync scan body\n', 'utf8');

    const fileDb = openFileSearchDb({ baseDir: projectDir, scanOnOpen: false, schedulerEnabled: false, semanticSearchEnabled: false });
    try {
      const status = fileDb.scanAndIndex({ trigger: 'manual' });
      expect(status).toMatchObject({ state: 'completed', trigger: 'manual', database: expect.objectContaining({ indexedFiles: 1 }) });
      const indexed = fileDb.db.prepare('SELECT path FROM indexed_files WHERE project_key = ?').all(status.projectKey) as Array<{ path: string }>;
      expect(indexed.map((row) => row.path)).toEqual([join(projectDir, 'sync.txt')]);
    } finally {
      fileDb.close();
    }
  });
});
