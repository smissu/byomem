import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNativeStore } from '../src/store.js';
import { captureSessionCheckpoint, openSessionCapture } from '../src/session-capture.js';

type SessionCaptureRuntime = ReturnType<typeof openSessionCapture>['runtime'];

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-runtime-session-'));
}

describe('session capture', () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('opens a real native queue runtime flow', () => {
    const dir = tempDir();
    dirs.push(dir);
    const result = openSessionCapture(openNativeStore({ baseDir: dir }), { baseDir: dir });

    expect((result.runtime as SessionCaptureRuntime).state().offset).toBe(0);
  });

  it('writes a native session checkpoint record from transcript input', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const transcriptPath = join(dir, 'session.jsonl');
    writeFileSync(transcriptPath, ['user: hello', 'assistant: hi there'].join('\n'), 'utf8');
    const store = openNativeStore({ baseDir: dir });

    const result = await captureSessionCheckpoint(store, { baseDir: dir }, {
      sessionId: 'session-alpha',
      transcriptPath,
      event: 'turn_end',
      messageCount: 2,
      final: false,
      idle: false,
      agent: 'assistant',
      model: 'test-model',
    });

    expect(result.checkpoint).toEqual([]);
    expect(result.rollup).toBeUndefined();
    expect(result.record).toMatchObject({
      scope: 'project',
      identity: {
        namespace: 'byomem-session',
        leafName: 'session-alpha',
        parentContext: 'root',
      },
      provenance: {
        source: 'session-capture',
        adapter: 'native-store',
        origin: 'session-capture',
      },
      content: {
        text: 'Session session-alpha checkpoint from turn_end',
        structured: {
          sessionId: 'session-alpha',
          event: 'turn_end',
          messageCount: 2,
          transcriptPath,
          transcriptPreview: ['user: hello', 'assistant: hi there'],
        },
      },
    });
    expect(store.list()).toHaveLength(1);
  });

  it('does not create a rollup record for checkpoint-only capture', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const transcriptPath = join(dir, 'session.jsonl');
    const store = openNativeStore({ baseDir: dir });

    writeFileSync(transcriptPath, ['user: hello', 'assistant: hi there'].join('\n'), 'utf8');
    await captureSessionCheckpoint(store, { baseDir: dir }, {
      sessionId: 'session-alpha',
      transcriptPath,
      event: 'turn_end',
      messageCount: 2,
      final: false,
      idle: false,
      agent: 'assistant',
      model: 'test-model',
    });

    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]).toMatchObject({
      identity: {
        namespace: 'byomem-session',
        leafName: 'session-alpha',
        parentContext: 'root',
      },
      provenance: {
        source: 'session-capture',
        adapter: 'native-store',
        origin: 'session-capture',
      },
      content: {
        text: 'Session session-alpha checkpoint from turn_end',
        structured: {
          sessionId: 'session-alpha',
          event: 'turn_end',
          final: false,
          idle: false,
          agent: 'assistant',
          model: 'test-model',
          transcriptPath,
          transcriptPreview: ['user: hello', 'assistant: hi there'],
        },
      },
    });
  });

  it('creates a rollup when final=true and idle=false', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const transcriptPath = join(dir, 'session.jsonl');
    const store = openNativeStore({ baseDir: dir });
    writeFileSync(transcriptPath, ['user: hello', 'assistant: hi there', 'user: thanks'].join('\n'), 'utf8');

    const checkpoint = await captureSessionCheckpoint(store, { baseDir: dir }, {
      sessionId: 'session-alpha',
      transcriptPath,
      event: 'session_shutdown',
      messageCount: 3,
      final: true,
      idle: false,
      agent: 'assistant',
      model: 'test-model',
      transcriptBytes: 47,
    });

    expect(checkpoint.record).toMatchObject({
      identity: {
        namespace: 'byomem-session',
        leafName: 'session-alpha',
        parentContext: 'root',
      },
      provenance: { source: 'session-capture', adapter: 'native-store', origin: 'session-capture' },
      content: {
        text: 'Session session-alpha checkpoint from session_shutdown',
        structured: expect.objectContaining({ kind: 'checkpoint', final: true, idle: false, messageCount: 3, transcriptBytes: 47 }),
      },
    });

    expect(checkpoint.rollup).toMatchObject({
      id: expect.any(String),
      identity: {
        namespace: 'byomem-session',
        leafName: 'session-alpha',
        parentContext: 'root',
      },
      provenance: { source: 'session-capture', adapter: 'native-store', origin: 'session-rollup' },
      content: {
        text: 'Session session-alpha distilled rollup from session_shutdown',
        structured: {
          kind: 'rollup',
          sessionId: 'session-alpha',
          final: true,
          idle: false,
          sourceStableKey: 'project:byomem-session:root:session-alpha',
          transcriptPreview: ['user: hello', 'assistant: hi there', 'user: thanks'],
        },
      },
    });
    expect(store.list()).toHaveLength(1);
    expect(checkpoint.rollup).toBeDefined();
  });

  it('creates a rollup when final=false and idle=true', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const transcriptPath = join(dir, 'session.jsonl');
    const store = openNativeStore({ baseDir: dir });
    writeFileSync(transcriptPath, ['user: hello', 'assistant: hi there', 'user: thanks'].join('\n'), 'utf8');

    const checkpoint = await captureSessionCheckpoint(store, { baseDir: dir }, {
      sessionId: 'session-alpha',
      transcriptPath,
      event: 'session_idle',
      messageCount: 3,
      final: false,
      idle: true,
      agent: 'assistant',
      model: 'test-model',
      transcriptBytes: 47,
    });

    expect(checkpoint.record).toMatchObject({
      identity: {
        namespace: 'byomem-session',
        leafName: 'session-alpha',
        parentContext: 'root',
      },
      provenance: { source: 'session-capture', adapter: 'native-store', origin: 'session-capture' },
      content: {
        text: 'Session session-alpha checkpoint from session_idle',
        structured: expect.objectContaining({ kind: 'checkpoint', final: false, idle: true, messageCount: 3, transcriptBytes: 47 }),
      },
    });

    expect(checkpoint.rollup).toMatchObject({
      id: expect.any(String),
      identity: {
        namespace: 'byomem-session',
        leafName: 'session-alpha',
        parentContext: 'root',
      },
      provenance: { source: 'session-capture', adapter: 'native-store', origin: 'session-rollup' },
      content: {
        text: 'Session session-alpha distilled rollup from session_idle',
        structured: {
          kind: 'rollup',
          sessionId: 'session-alpha',
          final: false,
          idle: true,
          sourceStableKey: 'project:byomem-session:root:session-alpha',
          transcriptPreview: ['user: hello', 'assistant: hi there', 'user: thanks'],
        },
      },
    });
    expect(store.list()).toHaveLength(1);
    expect(checkpoint.rollup).toBeDefined();
  });

  it('keeps rollup writes idempotent across repeated final replay', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const transcriptPath = join(dir, 'session.jsonl');
    const store = openNativeStore({ baseDir: dir });
    writeFileSync(transcriptPath, ['user: hello', 'assistant: hi there', 'user: thanks'].join('\n'), 'utf8');
    const first = await captureSessionCheckpoint(store, { baseDir: dir }, {
      sessionId: 'session-alpha',
      transcriptPath,
      event: 'session_shutdown',
      messageCount: 3,
      final: true,
      idle: true,
    });
    const second = await captureSessionCheckpoint(store, { baseDir: dir }, {
      sessionId: 'session-alpha',
      transcriptPath,
      event: 'session_shutdown',
      messageCount: 3,
      final: true,
      idle: true,
    });

    expect(second.rollup?.id).toBe(first.rollup?.id);
    expect(store.list().filter((record) => record.provenance.origin === 'session-rollup')).toHaveLength(1);
  });
});
