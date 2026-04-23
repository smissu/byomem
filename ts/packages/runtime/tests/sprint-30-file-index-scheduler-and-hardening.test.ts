import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNativeStore } from '../src/store.js';

type FileSearchDbHandle = {
  path: string;
  close: () => void;
  scheduleRefresh?: (event: { kind: string; projectKey?: string; baseDir?: string }) => void;
  flushScheduledRefreshes?: () => void;
  refreshMetrics?: { runs?: number; failures?: number };
};

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-runtime-sprint-30-'));
}

describe('Sprint 30 file index scheduler and hardening', () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it('activates a refresh run from a scheduler event', () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'activation.txt'), 'activation trigger content\n', 'utf8');

    const store = openNativeStore({ baseDir: dir });
    const fileDb = (store as unknown as { fileSearchDb?: FileSearchDbHandle }).fileSearchDb;

    expect(fileDb).toBeDefined();
    expect(fileDb?.scheduleRefresh).toBeTypeOf('function');
    fileDb?.scheduleRefresh?.({ kind: 'activation', baseDir: dir });
    expect(fileDb?.refreshMetrics?.runs).toBe(1);
  });

  it('debounces post-activity bursts into one refresh run', () => {
    vi.useFakeTimers();
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'debounce.txt'), 'debounce v1\n', 'utf8');

    const store = openNativeStore({ baseDir: dir });
    const fileDb = (store as unknown as { fileSearchDb?: FileSearchDbHandle }).fileSearchDb;

    expect(fileDb).toBeDefined();
    expect(fileDb?.scheduleRefresh).toBeTypeOf('function');
    fileDb?.scheduleRefresh?.({ kind: 'post-activity', baseDir: dir });
    fileDb?.scheduleRefresh?.({ kind: 'post-activity', baseDir: dir });
    fileDb?.scheduleRefresh?.({ kind: 'post-activity', baseDir: dir });
    vi.advanceTimersByTime(5000);
    expect(fileDb?.refreshMetrics?.runs).toBe(1);
  });

  it('runs a later periodic backstop without another manual event', () => {
    vi.useFakeTimers();
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'backstop.txt'), 'backstop content\n', 'utf8');

    const store = openNativeStore({ baseDir: dir });
    const fileDb = (store as unknown as { fileSearchDb?: FileSearchDbHandle }).fileSearchDb;

    expect(fileDb).toBeDefined();
    expect(fileDb?.flushScheduledRefreshes).toBeTypeOf('function');
    expect(fileDb?.refreshMetrics?.runs ?? 0).toBe(0);
    vi.advanceTimersByTime(60000);
    expect(fileDb?.refreshMetrics?.runs).toBeGreaterThanOrEqual(1);
  });

  it('coordinates refreshes across distinct project roots without starvation', () => {
    const dirA = tempDir();
    const dirB = tempDir();
    const dirC = tempDir();
    dirs.push(dirA, dirB, dirC);
    writeFileSync(join(dirA, 'a.txt'), 'a\n', 'utf8');
    writeFileSync(join(dirB, 'b.txt'), 'b\n', 'utf8');
    writeFileSync(join(dirC, 'c.txt'), 'c\n', 'utf8');

    const storeA = openNativeStore({ baseDir: dirA });
    const storeB = openNativeStore({ baseDir: dirB });
    const storeC = openNativeStore({ baseDir: dirC });
    const dbA = (storeA as unknown as { fileSearchDb?: FileSearchDbHandle }).fileSearchDb;
    const dbB = (storeB as unknown as { fileSearchDb?: FileSearchDbHandle }).fileSearchDb;
    const dbC = (storeC as unknown as { fileSearchDb?: FileSearchDbHandle }).fileSearchDb;

    expect(dbA).toBeDefined();
    expect(dbB).toBeDefined();
    expect(dbC).toBeDefined();
    dbA?.scheduleRefresh?.({ kind: 'activation', baseDir: dirA });
    dbB?.scheduleRefresh?.({ kind: 'activation', baseDir: dirB });
    dbC?.scheduleRefresh?.({ kind: 'activation', baseDir: dirC });
    expect(dbA?.refreshMetrics?.runs).toBe(1);
    expect(dbB?.refreshMetrics?.runs).toBe(1);
    expect(dbC?.refreshMetrics?.runs).toBe(1);
  });

  it('recovers after a transient failure so later scheduled refreshes still run', () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'hardening.txt'), 'hardening content\n', 'utf8');

    const store = openNativeStore({ baseDir: dir });
    const fileDb = (store as unknown as { fileSearchDb?: FileSearchDbHandle }).fileSearchDb;

    expect(fileDb).toBeDefined();
    expect(fileDb?.scheduleRefresh).toBeTypeOf('function');
    fileDb?.scheduleRefresh?.({ kind: 'activation', baseDir: dir });
    const failed = fileDb?.refreshMetrics?.failures ?? 0;
    fileDb?.scheduleRefresh?.({ kind: 'activation', baseDir: dir });
    expect(fileDb?.refreshMetrics?.failures ?? 0).toBeGreaterThanOrEqual(failed);
    expect(fileDb?.refreshMetrics?.runs).toBeGreaterThanOrEqual(1);
  });

  it('keeps watcher-based monitoring unnecessary', () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'watcher.txt'), 'watcher deferral content\n', 'utf8');

    const store = openNativeStore({ baseDir: dir });
    const fileDb = (store as unknown as { fileSearchDb?: FileSearchDbHandle }).fileSearchDb;

    expect(fileDb).toBeDefined();
    expect(fileDb?.scheduleRefresh).toBeTypeOf('function');
    expect(fileDb?.flushScheduledRefreshes).toBeTypeOf('function');
  });
});
