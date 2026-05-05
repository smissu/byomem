import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type ChunkSummary = {
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  language?: string;
};

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

function tempDir(prefix = 'byomem-s57-chonkie-readiness-'): string {
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

function extractChunks(result: unknown): ChunkSummary[] {
  if (Array.isArray(result)) return result as ChunkSummary[];
  if (result && typeof result === 'object') {
    const chunks = (result as { chunks?: unknown }).chunks;
    if (Array.isArray(chunks)) return chunks as ChunkSummary[];
  }
  throw new Error('Expected chunk list in readiness-aware chunking result');
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

async function loadChunkingModule(createMock: (...args: unknown[]) => unknown): Promise<Record<string, unknown>> {
  vi.resetModules();
  vi.doMock('@chonkiejs/core', () => ({
    CodeChunker: {
      create: createMock,
    },
  }));
  return await import('../src/file-search-semble.js') as Record<string, unknown>;
}

describe('Sprint 57 file-search Chonkie readiness contract', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('waits for pending Chonkie readiness on code files instead of silently falling back', async () => {
    const createGate = deferred<{ chunk: (content: string) => Array<{ text: string; startIndex: number; endIndex: number }> }>();
    const createMock = vi.fn(() => createGate.promise);
    const mod = await loadChunkingModule(createMock);
    const readyApi = mod.chunkFileContentReady;

    expect(readyApi).toEqual(expect.any(Function));

    const projectDir = tempDir();
    dirs.push(projectDir);
    const filePath = join(projectDir, 'ready.ts');
    const chunkText = 'export function alpha() {}';
    const resultPromise = (readyApi as (filePath: string, content: string) => Promise<unknown>)(filePath, chunkText);
    let settled = false;
    resultPromise.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);

    createGate.resolve({
      chunk: vi.fn(() => [{ text: chunkText, startIndex: 0, endIndex: chunkText.length }]),
    });

    const result = await resultPromise;
    expect(createMock).toHaveBeenCalled();
    expect(extractChunks(result)).toEqual([
      expect.objectContaining({
        filePath,
        content: chunkText,
        startLine: 1,
        endLine: 1,
        language: 'typescript',
      }),
    ]);

    const meta = extractChunkerMeta(result);
    expect(extractSource(meta)).toBe('chonkie');
    expect(extractFallbackReason(meta)).toBeUndefined();
  });

  it('does not wait for Chonkie readiness on text files', async () => {
    const createGate = deferred<{ chunk: (content: string) => Array<{ text: string; startIndex: number; endIndex: number }> }>();
    const createMock = vi.fn(() => createGate.promise);
    const mod = await loadChunkingModule(createMock);
    const readyApi = mod.chunkFileContentReady;

    expect(readyApi).toEqual(expect.any(Function));

    const projectDir = tempDir();
    dirs.push(projectDir);
    const filePath = join(projectDir, 'notes.txt');
    const resultPromise = (readyApi as (filePath: string, content: string) => Promise<unknown>)(filePath, 'plain text body');
    let settled = false;
    resultPromise.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(true);

    const result = await resultPromise;
    expect(extractChunks(result)).toEqual([
      expect.objectContaining({
        filePath,
        content: 'plain text body',
        startLine: 1,
        endLine: 1,
      }),
    ]);
  });

  it('returns deterministic fallback metadata for unsupported languages without waiting for chunker readiness', async () => {
    const createGate = deferred<{ chunk: (content: string) => Array<{ text: string; startIndex: number; endIndex: number }> }>();
    const createMock = vi.fn(() => createGate.promise);
    const mod = await loadChunkingModule(createMock);
    const readyApi = mod.chunkFileContentReady;

    expect(readyApi).toEqual(expect.any(Function));

    const projectDir = tempDir();
    dirs.push(projectDir);
    const filePath = join(projectDir, 'unknown.zig');
    const resultPromise = (readyApi as (filePath: string, content: string) => Promise<unknown>)(filePath, 'const answer = 42;');
    let settled = false;
    resultPromise.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(true);

    const result = await resultPromise;
    expect(extractChunks(result)).toEqual([
      expect.objectContaining({
        filePath,
        content: 'const answer = 42;',
        startLine: 1,
        endLine: 1,
      }),
    ]);

    const meta = extractChunkerMeta(result);
    expect(extractSource(meta)).not.toBe('chonkie');
    expect(extractFallbackReason(meta)).toBe('unsupported-language');
  });

  it('reports chunker exceptions as fallback metadata instead of throwing', async () => {
    const createMock = vi.fn(async () => ({
      chunk() {
        throw new Error('chunker blew up');
      },
    }));
    const mod = await loadChunkingModule(createMock);
    const readyApi = mod.chunkFileContentReady;

    expect(readyApi).toEqual(expect.any(Function));

    const projectDir = tempDir();
    dirs.push(projectDir);
    const filePath = join(projectDir, 'crash.ts');
    const result = await (readyApi as (filePath: string, content: string) => Promise<unknown>)(filePath, 'export const answer = 42;');

    expect(extractChunks(result)).toEqual([
      expect.objectContaining({
        filePath,
        content: 'export const answer = 42;',
        startLine: 1,
        endLine: 1,
        language: 'typescript',
      }),
    ]);

    const meta = extractChunkerMeta(result);
    expect(extractSource(meta)).not.toBe('chonkie');
    expect(extractFallbackReason(meta)).toBe('chunker-error');
  });
});
