import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { observeQueue, renderQueueObserver } from '../src/queue-observer.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-queue-observer-'));
}

describe('ts memory-processing observer cli', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.useRealTimers();
    process.exitCode = undefined;
  });

  it('loads snapshot state from queue.json and worker.json', () => {
    const dir = tempDir();
    dirs.push(dir);
    const snapshot = observeQueue({ baseDir: dir, history: 3, json: true });

    expect(snapshot).toMatchObject({
      format: 'json',
      worker: { sessionId: '', offset: 0, lock: null },
      queue: { totalJobs: 0, states: { queued: 0, checkpointed: 0, flushed: 0 } },
      recentJobs: [],
      health: { status: 'idle' },
      history: 3,
    });
    expect(snapshot.worker.workerId).toEqual(expect.any(String));
  });

  it('returns a deterministic empty worker snapshot when worker.json is missing', () => {
    const dir = tempDir();
    dirs.push(dir);

    const snapshot = observeQueue({ baseDir: dir, history: 2, json: false });

    expect(snapshot.worker).toEqual({ workerId: '', sessionId: '', offset: 0, lock: null });
    const text = renderQueueObserver(snapshot);
    expect(text).toContain('workerId: ');
    expect(text).toContain('sessionId: (empty)');
    expect(text).toContain('lock: (none)');
  });

  it('renders readable text output for empty state', () => {
    const dir = tempDir();
    dirs.push(dir);
    const snapshot = observeQueue({ baseDir: dir, history: 2, json: false });

    const text = renderQueueObserver(snapshot);
    expect(text).toContain('Worker');
    expect(text).toContain('Queue Summary');
    expect(text).toContain('Health');
    expect(text).toContain('Recent Jobs (2)');
  });

  it('reads bounded recent-job history from real queue state', () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(
      join(dir, 'queue.json'),
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              jobId: 'job-old-offset-high',
              sessionId: 'session-a',
              workerId: 'worker-a',
              offset: 9,
              state: 'checkpointed',
              event: { recordId: 'project:docs:alpha', kind: 'memory.write', createdAt: '2026-01-01T00:00:00.000Z', payload: { offset: 9 } },
              writeIntent: { identity: { namespace: 'docs', parentContext: 'alpha', leafName: 'memory-9' }, content: { text: 'Older processed alpha note' } },
            },
            {
              jobId: 'job-new-time-low-offset',
              sessionId: 'session-b',
              workerId: 'worker-b',
              offset: 1,
              state: 'queued',
              event: { recordId: 'project:notes:beta', kind: 'memory.write', createdAt: '2026-01-01T00:05:00.000Z', payload: { offset: 1 } },
              writeIntent: { identity: { namespace: 'notes', parentContext: 'beta', leafName: 'memory-1' }, content: { text: 'Newer beta activity from another session' } },
            },
            {
              jobId: 'job-middle',
              sessionId: 'session-c',
              workerId: 'worker-c',
              offset: 4,
              state: 'flushed',
              event: { recordId: 'project:journal:gamma', kind: 'memory.write', createdAt: '2026-01-01T00:02:00.000Z', payload: { offset: 4 } },
              writeIntent: { identity: { namespace: 'journal', parentContext: 'gamma', leafName: 'memory-4' }, content: { text: 'Middle activity' } },
            },
          ],
        },
        null,
        2,
      ),
    );
    writeFileSync(join(dir, 'worker.json'), JSON.stringify({ version: 1, state: { workerId: 'worker-c', sessionId: 'session-c', offset: 4, lock: null } }, null, 2));

    const snapshot = observeQueue({ baseDir: dir, history: 2, json: false });
    expect(snapshot.recentJobs).toHaveLength(2);
    expect(snapshot.recentJobs.map((job) => job.jobId)).toEqual(['job-new-time-low-offset', 'job-middle']);
    expect(snapshot.recentJobs[0]?.createdAt).toBe('2026-01-01T00:05:00.000Z');
    expect(snapshot.recentJobs[1]?.createdAt).toBe('2026-01-01T00:02:00.000Z');
    expect(snapshot.queue).toMatchObject({ totalJobs: 3, states: { queued: 1, checkpointed: 1, flushed: 1 } });
  });

  it('renders a simplified recent-job identifier in default text watch output', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(
      join(dir, 'queue.json'),
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              jobId: 'job-1',
              sessionId: 'session-a',
              workerId: 'worker-a',
              offset: 1,
              state: 'queued',
              event: { recordId: 'project:docs:alpha', kind: 'memory.write', createdAt: '2026-01-01T00:00:00.000Z', payload: { offset: 1 } },
              writeIntent: { identity: { namespace: 'docs', parentContext: 'alpha', leafName: 'memory-1' }, content: { text: 'Capture onboarding summary for alpha docs' } },
            },
          ],
        },
        null,
        2,
      ),
    );
    writeFileSync(join(dir, 'worker.json'), JSON.stringify({ version: 1, state: { workerId: 'worker-a', sessionId: 'session-a', offset: 1, lock: null } }, null, 2));
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['queue-observe', '--base-dir', dir, '--history', '1']);

    const output = String(spy.mock.calls.at(-1)?.[0] ?? '');
    expect(output).toContain('Recent Jobs (1)');
    expect(output).toContain('project:docs:alpha');
    expect(output).toContain('2026-01-01T00:00:00.000Z');
    expect(output).not.toContain('kind=memory.write');
    expect(output).not.toContain('snippet=');
    expect(output).not.toContain('docs/alpha');
    expect(output).not.toContain('Capture onboarding summary');
  });

  it('rejects malformed queue.json at the CLI contract boundary', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'queue.json'), '{not-json');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await main(['queue-observe', '--base-dir', dir, '--json']);

    expect(errorSpy).toHaveBeenCalled();
    expect(JSON.parse(String(errorSpy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      error: expect.stringContaining('JSON'),
      command: 'queue-observe',
    });
  });

  it('rejects malformed worker.json at the CLI contract boundary', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'worker.json'), '{not-json');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await main(['queue-observe', '--base-dir', dir, '--json']);

    expect(errorSpy).toHaveBeenCalled();
    expect(JSON.parse(String(errorSpy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      error: expect.stringContaining('JSON'),
      command: 'queue-observe',
    });
  });

  it('accepts queue-observe as a JSON-first snapshot command', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['queue-observe', '--base-dir', dir, '--json']);

    expect(JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      format: 'json',
      worker: { sessionId: '', offset: 0, lock: null },
      queue: { totalJobs: 0, states: { queued: 0, checkpointed: 0, flushed: 0 } },
      recentJobs: [],
      health: { status: 'idle' },
    });
  });

  it('rejects watch mode in JSON output for the Sprint 26 contract surface', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await main(['queue-observe', '--base-dir', dir, '--json', '--watch']);

    expect(errorSpy).toHaveBeenCalled();
    expect(JSON.parse(String(errorSpy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      error: expect.stringContaining('watch'),
      command: 'queue-observe',
    });
  });

  it('supports watch mode with the default interval contract', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const originalSigint = process.listeners('SIGINT');
    let capturedHandler: (() => void) | undefined;
    const onceSpy = vi.spyOn(process, 'once').mockImplementation((event: NodeJS.Signals, handler: never) => {
      if (event === 'SIGINT') capturedHandler = handler as unknown as () => void;
      return process;
    });
    const removeSpy = vi.spyOn(process, 'removeListener').mockImplementation(() => process);

    const run = main(['queue-observe', '--base-dir', dir, '--watch']);
    await new Promise((resolve) => setImmediate(resolve));
    capturedHandler?.();
    await run;

    expect(onceSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(writeSpy).toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(removeSpy).toHaveBeenCalled();
    expect(process.listeners('SIGINT')).toEqual(originalSigint);
  });

  it('remains alive across at least one interval until SIGINT stops watch mode', async () => {
    vi.useFakeTimers();
    const dir = tempDir();
    dirs.push(dir);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let capturedHandler: (() => void) | undefined;
    vi.spyOn(process, 'once').mockImplementation((event: NodeJS.Signals, handler: never) => {
      if (event === 'SIGINT') capturedHandler = handler as unknown as () => void;
      return process;
    });
    vi.spyOn(process, 'removeListener').mockImplementation(() => process);

    const run = main(['queue-observe', '--base-dir', dir, '--watch']);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2000);
    await Promise.resolve();

    expect(writeSpy).toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    let settled = false;
    run.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    capturedHandler?.();
    await run;
  });

  it('accepts an explicit watch interval override', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let capturedHandler: (() => void) | undefined;
    const onceSpy = vi.spyOn(process, 'once').mockImplementation((event: NodeJS.Signals, handler: never) => {
      if (event === 'SIGINT') capturedHandler = handler as unknown as () => void;
      return process;
    });

    const run = main(['queue-observe', '--base-dir', dir, '--watch', '--watch-interval', '0.5']);
    await new Promise((resolve) => setImmediate(resolve));
    capturedHandler?.();
    await run;

    expect(onceSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(writeSpy).toHaveBeenCalled();
  });

  it('redraws the screen on each watch refresh instead of appending output', async () => {
    vi.useFakeTimers();
    const dir = tempDir();
    dirs.push(dir);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let capturedHandler: (() => void) | undefined;
    vi.spyOn(process, 'once').mockImplementation((event: NodeJS.Signals, handler: never) => {
      if (event === 'SIGINT') capturedHandler = handler as unknown as () => void;
      return process;
    });
    vi.spyOn(process, 'removeListener').mockImplementation(() => process);

    const run = main(['queue-observe', '--base-dir', dir, '--watch', '--watch-interval', '0.25']);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);
    await Promise.resolve();

    const writes = writeSpy.mock.calls.map(([chunk]) => String(chunk));
    expect(writes.some((chunk) => chunk.includes('\u001b'))).toBe(true);
    expect(writes.some((chunk) => chunk.includes('Worker') || chunk.includes('Queue Summary'))).toBe(true);
    expect(writes.some((chunk) => chunk.startsWith('\u001b'))).toBe(true);

    capturedHandler?.();
    await run;
  });

  it('rejects invalid watch intervals', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await main(['queue-observe', '--base-dir', dir, '--watch', '--watch-interval', '0']);

    expect(errorSpy).toHaveBeenCalled();
    expect(JSON.parse(String(errorSpy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      error: expect.stringContaining('watch-interval'),
      command: 'queue-observe',
    });
  });

  it('reports bounded recent-job history and queue/worker summary in text mode', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['queue-observe', '--base-dir', dir, '--history', '2']);

    expect(String(spy.mock.calls.at(-1)?.[0] ?? '')).toContain('Queue Summary');
    expect(String(spy.mock.calls.at(-1)?.[0] ?? '')).toContain('Recent Jobs (2)');
  });

  it('supports JSON output contract for the observer', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['queue-observe', '--base-dir', dir, '--json', '--history', '3']);

    expect(JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      format: 'json',
      history: 3,
      worker: expect.objectContaining({ workerId: expect.any(String) }),
      queue: expect.objectContaining({ totalJobs: 0 }),
      recentJobs: [],
      health: expect.any(Object),
    });
  });
});