import { afterEach, describe, expect, it } from 'vitest';
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

  it('updates the same session checkpoint record on repeated capture', async () => {
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
    });

    writeFileSync(transcriptPath, ['user: hello', 'assistant: hi there', 'user: thanks'].join('\n'), 'utf8');
    const result = await captureSessionCheckpoint(store, { baseDir: dir }, {
      sessionId: 'session-alpha',
      transcriptPath,
      event: 'session_shutdown',
      messageCount: 3,
      final: true,
    });

    expect(store.list()).toHaveLength(1);
    expect(result.record).toMatchObject({
      identity: {
        namespace: 'byomem-session',
        leafName: 'session-alpha',
      },
      content: {
        text: 'Session session-alpha checkpoint from session_shutdown',
        structured: {
          event: 'session_shutdown',
          messageCount: 3,
          final: true,
          transcriptPreview: ['user: hello', 'assistant: hi there', 'user: thanks'],
        },
      },
    });
  });
});
