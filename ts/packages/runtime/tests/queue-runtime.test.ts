import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeKey } from '../src/store.js';
import { openNativeStore } from '../src/store.js';
import { openQueueRuntime } from '../src/queue-runtime.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-runtime-queue-'));
}

describe('queue runtime', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('progresses queued to checkpointed to flushed and persists the written record', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const store = openNativeStore({ baseDir: dir });
    const runtime = openQueueRuntime(store, { baseDir: dir });

    const event = await runtime.capture('session|evt-1|1|hello world', {
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Session Record', parentContext: 'root' },
      content: { text: 'hello world' },
      provenance: { source: 'fixtures' },
    });

    expect(event?.eventId).toBe('evt-1');
    expect(store.list()).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, 'queue.json'), 'utf8'))).toMatchObject({
      version: 1,
      jobs: [
        {
          jobId: 'evt-1',
          sessionId: 'session',
          offset: 1,
          state: 'flushed',
          writeIntent: expect.objectContaining({ content: { text: 'hello world' } }),
          event: expect.objectContaining({ eventId: 'evt-1', kind: 'capture' }),
        },
      ],
    });
  });

  it('is replay idempotent and restart-safe for offset recovery', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const store = openNativeStore({ baseDir: dir });
    const runtime = openQueueRuntime(store, { baseDir: dir });

    runtime.capture('session|evt-2|2|alpha', {
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Alpha', parentContext: 'root' },
      content: { text: 'alpha' },
      provenance: { source: 'fixtures' },
    });
    const stateBefore = runtime.state();
    const statePath = join(dir, 'worker.json');
    writeFileSync(statePath, JSON.stringify({ version: 1, state: stateBefore }, null, 2));

    const rerun = openQueueRuntime(store, { baseDir: dir });
    expect(rerun.state()).toMatchObject(stateBefore);
    const replay = await rerun.replay({ eventId: 'evt-2', sessionId: 'session', recordId: 'evt-2', kind: 'replay', createdAt: new Date().toISOString(), payload: { offset: 2 } }, {
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Alpha', parentContext: 'root' },
      content: { text: 'alpha' },
      provenance: { source: 'fixtures' },
    });
    expect(replay).toBeUndefined();
    expect(rerun.state().offset).toBeGreaterThanOrEqual(2);
    const queueState = JSON.parse(readFileSync(join(dir, 'queue.json'), 'utf8')) as { version: number; jobs: Array<{ jobId: string; state: string; offset: number; sessionId: string; workerId: string }> };
    expect(queueState).toMatchObject({
      version: 1,
      jobs: [expect.objectContaining({ jobId: 'evt-2', state: 'checkpointed', offset: 2, sessionId: 'session', workerId: expect.any(String) })],
    });
    expect(queueState.jobs[0]?.workerId).toBe(rerun.state().workerId);
    expect(store[storeKey] ?? true).toBe(true);
  });

  it('rejects duplicate replay after restart from persisted queue state', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const store = openNativeStore({ baseDir: dir });
    const runtime = openQueueRuntime(store, { baseDir: dir });

    runtime.capture('session|evt-3|3|bravo', {
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Bravo', parentContext: 'root' },
      content: { text: 'bravo' },
      provenance: { source: 'fixtures' },
    });
    const workerState = runtime.state();
    writeFileSync(join(dir, 'worker.json'), JSON.stringify({ version: 1, state: workerState }, null, 2));

    const restarted = openQueueRuntime(store, { baseDir: dir });
    expect(restarted.state()).toMatchObject(workerState);
    expect(await restarted.replay({ eventId: 'evt-3', sessionId: 'session', recordId: 'evt-3', kind: 'replay', createdAt: new Date().toISOString(), payload: { offset: 3 } }, {
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'Bravo', parentContext: 'root' },
      content: { text: 'bravo' },
      provenance: { source: 'fixtures' },
    })).toBeUndefined();
    expect(restarted.state().offset).toBeGreaterThanOrEqual(3);
    const queueState = JSON.parse(readFileSync(join(dir, 'queue.json'), 'utf8')) as { version: number; jobs: Array<{ jobId: string; state: string; offset: number; sessionId: string; workerId: string }> };
    expect(queueState).toMatchObject({
      version: 1,
      jobs: [expect.objectContaining({ jobId: 'evt-3', state: 'checkpointed', offset: 3, sessionId: 'session', workerId: expect.any(String) })],
    });
    expect(queueState.jobs[0]?.workerId).toBe(restarted.state().workerId);
  });
});
