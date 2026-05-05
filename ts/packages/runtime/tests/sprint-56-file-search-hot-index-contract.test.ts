import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSearchIndex } from '../src/index.js';
import { openNativeStore } from '../src/store.js';

function tempDir(prefix = 'byomem-sprint-56-hot-index-contract-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function seedProject(projectDir: string): void {
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  writeFileSync(join(projectDir, 'src', 'alpha.ts'), 'export function alphaRoute() {\n  return 1;\n}\n', 'utf8');
  writeFileSync(join(projectDir, 'src', 'beta.ts'), 'export function betaRoute() {\n  return 2;\n}\n', 'utf8');
  writeFileSync(join(projectDir, 'notes.md'), 'alpha project notes\n', 'utf8');
}

function trackFullCorpusLoads(fileDb: NonNullable<ReturnType<typeof openNativeStore>['fileSearchDb']>) {
  const handle = fileDb as { db: Record<string, unknown> };
  const originalDb = handle.db;
  const originalPrepare = (originalDb.prepare as (...args: unknown[]) => unknown).bind(originalDb);
  let fullCorpusLoadCount = 0;
  const proxyDb = new Proxy(originalDb, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return ((sql: string, ...args: unknown[]) => {
          const statement = originalPrepare(sql, ...args) as Record<string, unknown>;
          if (typeof sql === 'string' && sql.includes('FROM indexed_chunks') && sql.includes('JOIN file_records')) {
            return new Proxy(statement, {
              get(statementTarget, statementProp, statementReceiver) {
                if (statementProp === 'all') {
                  return ((...statementArgs: unknown[]) => {
                    fullCorpusLoadCount += 1;
                    return Reflect.apply(
                      statementTarget.all as (...allArgs: unknown[]) => unknown,
                      statementTarget,
                      statementArgs,
                    );
                  }) as never;
                }
                return Reflect.get(statementTarget, statementProp, statementReceiver);
              },
            });
          }
          return statement;
        }) as never;
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  handle.db = proxyDb;
  return {
    get count(): number {
      return fullCorpusLoadCount;
    },
    restore(): void {
      handle.db = originalDb;
    },
  };
}

describe('Sprint 56 file-search hot index contract', () => {
  const dirs: string[] = [];
  const stores: Array<ReturnType<typeof openNativeStore>> = [];

  afterEach(() => {
    vi.restoreAllMocks();
    while (stores.length) stores.pop()?.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('reports hot-index lifecycle diagnostics in stats without forcing another full reload', async () => {
    const projectDir = tempDir();
    dirs.push(projectDir);
    seedProject(projectDir);

    const store = openNativeStore({
      baseDir: projectDir,
      fileSearchIncludeTextFiles: true,
      fileSearchScanOnOpen: false,
      fileSearchSchedulerEnabled: false,
      fileSearchSemanticEnabled: false,
    });
    stores.push(store);
    store.fileSearchDb?.scanAndIndex();

    const fileDb = store.fileSearchDb;
    expect(fileDb).toBeDefined();
    const tracker = trackFullCorpusLoads(fileDb!);
    try {
      const index = FileSearchIndex.fromPath(store, projectDir);
      const warmHits = await index.search('alpha route', { mode: 'hybrid', topK: 5, filterLanguages: ['typescript'] });
      expect(warmHits).not.toHaveLength(0);
      const loadCountAfterWarmSearch = tracker.count;
      expect(loadCountAfterWarmSearch).toBeGreaterThan(0);

      const stats = index.stats() as {
        build?: {
          startedAt?: string;
          completedAt?: string;
          elapsedMs?: number;
          projectFingerprint?: string;
          backendVersion?: string;
        };
        hotIndex?: {
          state?: string;
          hydrate?: {
            startedAt?: string;
            completedAt?: string;
            elapsedMs?: number;
          };
        };
      };

      expect(stats).toMatchObject({
        build: {
          startedAt: expect.any(String),
          completedAt: expect.any(String),
          elapsedMs: expect.any(Number),
          projectFingerprint: expect.any(String),
          backendVersion: expect.any(String),
        },
        hotIndex: {
          state: expect.stringMatching(/^(cold|hydrating|hydrated|ready|stale|building|failed)$/),
          hydrate: {
            startedAt: expect.any(String),
            completedAt: expect.any(String),
            elapsedMs: expect.any(Number),
          },
        },
      });
      expect(tracker.count).toBe(loadCountAfterWarmSearch);
    } finally {
      tracker.restore();
    }
  });

  it('reuses a warm hot snapshot for repeated searches instead of loading the corpus again', async () => {
    const projectDir = tempDir();
    dirs.push(projectDir);
    seedProject(projectDir);

    const store = openNativeStore({
      baseDir: projectDir,
      fileSearchIncludeTextFiles: true,
      fileSearchScanOnOpen: false,
      fileSearchSchedulerEnabled: false,
      fileSearchSemanticEnabled: false,
    });
    stores.push(store);
    store.fileSearchDb?.scanAndIndex();

    const fileDb = store.fileSearchDb;
    expect(fileDb).toBeDefined();
    const tracker = trackFullCorpusLoads(fileDb!);
    try {
      const firstIndex = FileSearchIndex.fromPath(store, projectDir);
      const firstHits = await firstIndex.search('alpha route', { mode: 'hybrid', topK: 5, filterLanguages: ['typescript'] });
      expect(firstHits).not.toHaveLength(0);
      const loadCountAfterFirstSearch = tracker.count;
      expect(loadCountAfterFirstSearch).toBeGreaterThan(0);

      const secondIndex = FileSearchIndex.fromPath(store, projectDir);
      const secondHits = await secondIndex.search('alpha route', { mode: 'hybrid', topK: 5, filterLanguages: ['typescript'] });
      expect(secondHits).toEqual(firstHits);
      expect(tracker.count).toBe(loadCountAfterFirstSearch);
    } finally {
      tracker.restore();
    }
  });
});
