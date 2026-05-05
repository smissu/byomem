import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type ChunkerMeta = {
  source?: string;
  kind?: string;
  mode?: string;
  fallbackReason?: string;
  reason?: string;
  ready?: boolean;
  waitedForReadiness?: boolean;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
};

function tempDir(prefix = 'byomem-s57-chonkie-sync-compat-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function extractChunkerMeta(result: unknown): ChunkerMeta | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const container = result as Record<string, unknown>;
  for (const key of ['chunker', 'chunking', 'chunkerDiagnostics', 'chunkingDiagnostics', 'compatibility']) {
    const value = container[key];
    if (value && typeof value === 'object') return value as ChunkerMeta;
  }
  return undefined;
}

function extractSource(meta: ChunkerMeta | undefined): string | undefined {
  if (!meta) return undefined;
  return meta.source ?? meta.kind ?? meta.mode;
}

function extractFallbackReason(meta: ChunkerMeta | undefined): string | undefined {
  if (!meta) return undefined;
  return meta.fallbackReason ?? meta.reason;
}

async function loadFileSearchDbModule(createMock: (...args: unknown[]) => unknown): Promise<Record<string, unknown>> {
  vi.resetModules();
  vi.doMock('@chonkiejs/core', () => ({
    CodeChunker: {
      create: createMock,
    },
  }));
  return await import('../src/file-search-db.js') as Record<string, unknown>;
}

describe('Sprint 57 file-search Chonkie sync compatibility', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('keeps scanAndIndex synchronous while code chunker readiness is still pending', async () => {
    const createGate = deferred<{ chunk: (content: string) => Array<{ text: string; startIndex: number; endIndex: number }> }>();
    const createMock = vi.fn(() => createGate.promise);
    const mod = await loadFileSearchDbModule(createMock);
    const openFileSearchDb = mod.openFileSearchDb;

    expect(openFileSearchDb).toEqual(expect.any(Function));

    const projectDir = tempDir();
    const runtimeDir = tempDir();
    dirs.push(projectDir, runtimeDir);
    writeFileSync(join(projectDir, 'compat.ts'), 'export const compat = 1;\n', 'utf8');

    const fileDb = openFileSearchDb({
      baseDir: projectDir,
      dbBaseDir: runtimeDir,
      scanOnOpen: false,
      schedulerEnabled: false,
      semanticSearchEnabled: false,
    }) as {
      scanAndIndex(options?: { trigger?: string }): unknown;
      getScannerStatus(): unknown;
      close(): void;
    };

    try {
      const status = fileDb.scanAndIndex({ trigger: 'manual' });

      expect((status as { then?: unknown }).then).toBeUndefined();
      expect(status).toMatchObject({
        state: 'completed',
        trigger: 'manual',
        database: expect.objectContaining({
          indexedFiles: 1,
          indexedChunks: expect.any(Number),
        }),
      });

      const scanMeta = extractChunkerMeta(status);
      expect(scanMeta).toBeDefined();
      expect(extractSource(scanMeta)).not.toBe('chonkie');
      expect(extractFallbackReason(scanMeta)).toEqual(expect.any(String));

      const persistedMeta = extractChunkerMeta(fileDb.getScannerStatus());
      expect(persistedMeta).toBeDefined();
      expect(extractFallbackReason(persistedMeta)).toBe(extractFallbackReason(scanMeta));
    } finally {
      fileDb.close();
    }
  });
});
