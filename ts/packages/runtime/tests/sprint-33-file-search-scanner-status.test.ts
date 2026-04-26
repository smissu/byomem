import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFileSearchDb } from '../src/index.js';
import { openNativeStore } from '../src/store.js';
import { main } from '../src/cli.js';

type ScannerState = 'idle' | 'running' | 'completed' | 'failed' | 'abandoned';
type ScannerProgress = {
  discoveredFiles: number;
  scannedFiles: number;
  indexedFiles: number;
  unchangedFiles: number;
  changedFiles: number;
  deletedFiles: number;
  ignoredFiles: number;
  errorFiles: number;
  chunksWritten: number;
  bytesRead?: number;
  filesRemaining?: number;
};
type ScannerStatus = {
  state: ScannerState;
  projectKey: string;
  baseDir: string;
  runId?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  currentPath?: string;
  lastPath?: string;
  lastError?: string;
  trigger?: 'open' | 'manual' | 'scheduler-activation' | 'scheduler-post-activity' | 'scheduler-backstop';
  progress: ScannerProgress;
  database: {
    indexedFiles: number;
    indexedChunks: number;
    changedRows: number;
    reconciledRows: number;
    projects: Array<{ projectKey: string; files: number }>;
  };
  embeddings?: {
    enabled: boolean;
    model: string;
    configuredDimension: number;
    embeddedChunks: number;
    missingChunks: number;
    failures: number;
    fallbacks: number;
    lastError?: string;
  };
};
type Store = ReturnType<typeof openNativeStore>;
type StoreWithScannerStatus = Store & { fileSearchDb?: Store['fileSearchDb'] & { getScannerStatus?: () => ScannerStatus } };

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-runtime-sprint-33-'));
}

function openStore(dir: string, options: Partial<Parameters<typeof openNativeStore>[0]> = {}): StoreWithScannerStatus {
  return openNativeStore({ baseDir: dir, ...options }) as StoreWithScannerStatus;
}

function getScannerStatus(store: StoreWithScannerStatus): ScannerStatus {
  expect(store.fileSearchDb?.getScannerStatus, 'FileSearchDbHandle must expose getScannerStatus()').toEqual(expect.any(Function));
  return store.fileSearchDb!.getScannerStatus!();
}

function expectCompletedStatusShape(status: ScannerStatus, dir: string): void {
  expect(status).toMatchObject({
    state: 'completed',
    projectKey: expect.stringMatching(/^project:/),
    baseDir: dir,
    runId: expect.any(String),
    startedAt: expect.any(String),
    completedAt: expect.any(String),
    durationMs: expect.any(Number),
    trigger: expect.any(String),
    progress: {
      discoveredFiles: expect.any(Number),
      scannedFiles: expect.any(Number),
      indexedFiles: expect.any(Number),
      unchangedFiles: expect.any(Number),
      changedFiles: expect.any(Number),
      deletedFiles: expect.any(Number),
      ignoredFiles: expect.any(Number),
      errorFiles: expect.any(Number),
      chunksWritten: expect.any(Number),
    },
    database: {
      indexedFiles: expect.any(Number),
      indexedChunks: expect.any(Number),
      changedRows: expect.any(Number),
      reconciledRows: expect.any(Number),
      projects: expect.arrayContaining([expect.objectContaining({ projectKey: expect.stringMatching(/^project:/), files: expect.any(Number) })]),
    },
    embeddings: expect.objectContaining({
      enabled: expect.any(Boolean),
      model: expect.any(String),
      configuredDimension: expect.any(Number),
      embeddedChunks: expect.any(Number),
      missingChunks: expect.any(Number),
      failures: expect.any(Number),
      fallbacks: expect.any(Number),
    }),
  });
  expect(new Date(status.startedAt!).toString()).not.toBe('Invalid Date');
  expect(new Date(status.completedAt!).toString()).not.toBe('Invalid Date');
  expect(status.currentPath).toBeUndefined();
  expect(status.lastError).toBeUndefined();
}

describe('Sprint 33 file-search scanner status/progress RED contract', () => {
  const dirs: string[] = [];
  const stores: Store[] = [];
  const originalFetch = globalThis.fetch;
  const originalRuntimeBase = process.env.BYOMEM_RUNTIME_BASE_DIR;

  beforeEach(() => {
    const runtimeDir = tempDir();
    dirs.push(runtimeDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
  });

  afterEach(() => {
    while (stores.length) stores.pop()?.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    if (originalRuntimeBase === undefined) delete process.env.BYOMEM_RUNTIME_BASE_DIR;
    else process.env.BYOMEM_RUNTIME_BASE_DIR = originalRuntimeBase;
    process.exitCode = undefined;
  });

  it('exports a public file-search DB API that exposes getScannerStatus()', () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'public-api.txt'), 'public api\n', 'utf8');

    const fileDb = openFileSearchDb({ baseDir: dir });
    try {
      const status = fileDb.getScannerStatus();
      expect(status).toMatchObject({ state: 'completed', baseDir: dir, database: expect.objectContaining({ indexedFiles: 1 }) });
    } finally {
      fileDb.close();
    }
  });

  it('exposes getScannerStatus() with completed open-scan lifecycle, timing, counters, DB counts, and embedding diagnostics', () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'alpha.txt'), 'alpha line one\nalpha line two\n', 'utf8');

    const store = openStore(dir);
    stores.push(store);
    const status = getScannerStatus(store);

    expectCompletedStatusShape(status, dir);
    expect(status.trigger).toBe('open');
    expect(status.progress.discoveredFiles).toBeGreaterThanOrEqual(1);
    expect(status.progress.scannedFiles).toBeGreaterThanOrEqual(1);
    expect(status.progress.indexedFiles).toBeGreaterThanOrEqual(1);
    expect(status.progress.changedFiles).toBeGreaterThanOrEqual(1);
    expect(status.progress.deletedFiles).toBe(0);
    expect(status.progress.errorFiles).toBe(0);
    expect(status.progress.chunksWritten).toBeGreaterThanOrEqual(2);
    expect(status.database.indexedFiles).toBeGreaterThanOrEqual(1);
    expect(status.database.indexedChunks).toBeGreaterThanOrEqual(2);
    expect(status.database.changedRows).toBeGreaterThanOrEqual(1);
    expect(status.database.reconciledRows).toBeGreaterThanOrEqual(1);
    expect(status.embeddings).toMatchObject({ enabled: true, missingChunks: expect.any(Number) });
  });

  it('updates completed manual-scan counters for unchanged, changed, deleted, ignored, and chunksWritten cases', () => {
    const dir = tempDir();
    dirs.push(dir);
    mkdirSync(join(dir, 'ignored-dir'), { recursive: true });
    writeFileSync(join(dir, '.gitignore'), 'ignored-dir/\n*.log\n', 'utf8');
    const changedPath = join(dir, 'changed.txt');
    const deletedPath = join(dir, 'deleted.txt');
    writeFileSync(changedPath, 'changed v1\n', 'utf8');
    writeFileSync(deletedPath, 'deleted v1\n', 'utf8');
    writeFileSync(join(dir, 'unchanged.txt'), 'unchanged v1\n', 'utf8');
    writeFileSync(join(dir, 'debug.log'), 'ignored log content\n', 'utf8');
    writeFileSync(join(dir, 'ignored-dir', 'secret.txt'), 'ignored secret content\n', 'utf8');

    const store = openStore(dir);
    stores.push(store);
    writeFileSync(changedPath, 'changed v2\nchanged v2 second chunk\n', 'utf8');
    unlinkSync(deletedPath);
    store.fileSearchDb?.scanAndIndex();

    const status = getScannerStatus(store);
    expectCompletedStatusShape(status, dir);
    expect(status.trigger).toBe('manual');
    expect(status.progress.scannedFiles).toBeGreaterThanOrEqual(3);
    expect(status.progress.unchangedFiles).toBeGreaterThanOrEqual(1);
    expect(status.progress.changedFiles).toBeGreaterThanOrEqual(1);
    expect(status.progress.deletedFiles).toBeGreaterThanOrEqual(1);
    expect(status.progress.ignoredFiles).toBeGreaterThanOrEqual(2);
    expect(status.progress.errorFiles).toBe(0);
    expect(status.progress.chunksWritten).toBeGreaterThanOrEqual(2);
    expect(status.lastPath).not.toContain('debug.log');
    expect(status.lastPath).not.toContain('secret.txt');
    expect(status.currentPath).toBeUndefined();
    expect(status.database.indexedFiles).toBeGreaterThanOrEqual(3);
    expect(status.database.indexedChunks).toBeGreaterThanOrEqual(3);
  });

  it('persists failed scanner status with a useful error when a synchronous scan fails', () => {
    const dir = tempDir();
    dirs.push(dir);
    const filePath = join(dir, 'unreadable.txt');
    writeFileSync(filePath, 'readable first\n', 'utf8');
    const store = openStore(dir);
    stores.push(store);

    chmodSync(filePath, 0o000);
    try {
      expect(() => store.fileSearchDb?.scanAndIndex()).toThrow();
      const status = getScannerStatus(store);
      expect(status).toMatchObject({
        state: 'failed',
        trigger: 'manual',
        lastError: expect.any(String),
        completedAt: expect.any(String),
        progress: expect.objectContaining({ errorFiles: 1 }),
      });
    } finally {
      chmodSync(filePath, 0o600);
    }
  });

  it('records scheduler trigger/source when refreshes invoke the synchronous scanner', () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'scheduled.txt'), 'scheduled v1\n', 'utf8');
    const store = openStore(dir);
    stores.push(store);

    writeFileSync(join(dir, 'scheduled.txt'), 'scheduled v2\n', 'utf8');
    store.fileSearchDb?.scheduleRefresh({ kind: 'activation' });

    const status = getScannerStatus(store);
    expect(status).toMatchObject({ state: 'completed', trigger: 'scheduler-activation' });
    expect(status.progress.changedFiles).toBeGreaterThanOrEqual(1);
  });

  it('persists scanner status only in the file-search DB, not the memories DB or native snapshot', () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'status-boundary.txt'), 'status boundary\n', 'utf8');
    const store = openStore(dir);
    stores.push(store);
    const status = getScannerStatus(store);

    expect(status.state).toBe('completed');
    expect(store.fileSearchDb?.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'file_search_scanner_status'").get()).toBeTruthy();
    expect(store.sidecar?.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'file_search_scanner_status'").get()).toBeUndefined();
    expect(existsSync(join(dir, 'native-store.json'))).toBe(false);
  });

  it('recovers a stale persisted running scanner snapshot as abandoned on status read without starting a scan', () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'alpha.txt'), 'alpha body\n', 'utf8');
    const store = openStore(dir);
    const dbPath = store.fileSearchDb!.path;
    const projectKey = getScannerStatus(store).projectKey;
    store.close();

    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS file_search_scanner_status (
          project_key TEXT PRIMARY KEY,
          state TEXT NOT NULL,
          run_id TEXT,
          trigger TEXT,
          base_dir TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          duration_ms INTEGER,
          current_path TEXT,
          last_path TEXT,
          last_error TEXT,
          progress_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      db.prepare(`INSERT OR REPLACE INTO file_search_scanner_status
        (project_key, state, run_id, trigger, base_dir, started_at, progress_json, updated_at)
        VALUES (?, 'running', 'stale-run-1', 'manual', ?, '2000-01-01T00:00:00.000Z', ?, '2000-01-01T00:00:01.000Z')`).run(
        projectKey,
        dir,
        JSON.stringify({ discoveredFiles: 1, scannedFiles: 0, indexedFiles: 0, unchangedFiles: 0, changedFiles: 0, deletedFiles: 0, ignoredFiles: 0, errorFiles: 0, chunksWritten: 0, filesRemaining: 1 }),
      );
    } finally {
      db.close();
    }

    const reopened = openStore(dir);
    stores.push(reopened);
    const status = getScannerStatus(reopened);

    expect(status).toMatchObject({
      state: 'abandoned',
      runId: 'stale-run-1',
      trigger: 'manual',
      lastError: expect.stringMatching(/stale|abandoned|interrupted/i),
      completedAt: expect.any(String),
    });
    expect(status.progress.errorFiles).toBe(0);
  });

  it('returns scanner status without triggering semantic embedding refresh or hidden async scanner work', () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'semantic.txt'), 'semantic status body\n', 'utf8');
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ embedding: [1, 0, 0] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const store = openStore(dir, { embeddingBaseUrl: 'http://localhost:11434', fileSearchSemanticEnabled: true });
    stores.push(store);

    const beforeRows = store.fileSearchDb?.db.prepare('SELECT COUNT(*) AS count FROM indexed_chunk_embeddings').get() as { count: number };
    const status = getScannerStatus(store);
    const afterRows = store.fileSearchDb?.db.prepare('SELECT COUNT(*) AS count FROM indexed_chunk_embeddings').get() as { count: number };

    expect(status.embeddings).toMatchObject({ enabled: true, missingChunks: expect.any(Number), embeddedChunks: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(afterRows.count).toBe(beforeRows.count);
  });

  it('prints stable JSON scanner status from file-search-status after a completed scan without rescanning', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'cli-status.txt'), 'cli status body\n', 'utf8');
    const primingStore = openStore(dir);
    const primedRunId = getScannerStatus(primingStore).runId;
    primingStore.close();
    writeFileSync(join(dir, 'after-status.txt'), 'must not be scanned by status\n', 'utf8');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['file-search-status', '--base-dir', dir, '--json']);

    const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}')) as { scanner?: ScannerStatus };
    expect(process.exitCode).toBeUndefined();
    expect(output).toMatchObject({ scanner: { state: 'completed', baseDir: dir, runId: primedRunId, progress: expect.any(Object), database: expect.any(Object) } });
    expect(output.scanner?.database.indexedFiles).toBe(1);
    expect(output.scanner?.database.indexedChunks).toBeGreaterThanOrEqual(1);
  });

  it('prints initialized empty JSON scanner status before any user files exist', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['file-search-status', '--base-dir', dir, '--json']);

    const output = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}')) as { scanner?: ScannerStatus };
    expect(process.exitCode).toBeUndefined();
    expect(output).toMatchObject({ scanner: { state: 'idle', baseDir: dir } });
    expect(output.scanner?.database.indexedFiles).toBe(0);
    expect(output.scanner?.database.indexedChunks).toBe(0);
  });
});
