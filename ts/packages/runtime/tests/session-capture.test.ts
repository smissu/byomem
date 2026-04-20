import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openNativeStore } from '../src/store.js';
import { captureSessionCheckpoint, openSessionCapture } from '../src/session-capture.js';

type SessionCaptureRuntime = ReturnType<typeof openSessionCapture>['runtime'];

type TranscriptTurn = { id: string; user: string; assistant: string; timestamp?: string };

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-runtime-session-'));
}

function writeEventTranscript(path: string, turns: TranscriptTurn[]): void {
  const lines: string[] = [
    JSON.stringify({ type: 'session', version: 3, id: 'session-alpha', timestamp: '2026-04-20T00:00:00.000Z' }),
  ];

  for (const turn of turns) {
    lines.push(JSON.stringify({
      type: 'message',
      id: `${turn.id}-user`,
      timestamp: turn.timestamp ?? '2026-04-20T00:00:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: turn.user }],
        timestamp: turn.timestamp ?? '2026-04-20T00:00:00.000Z',
      },
    }));
    lines.push(JSON.stringify({
      type: 'message',
      id: `${turn.id}-assistant`,
      parentId: `${turn.id}-user`,
      timestamp: turn.timestamp ?? '2026-04-20T00:00:01.000Z',
      message: {
        role: 'assistant',
        parentId: `${turn.id}-user`,
        content: [{ type: 'text', text: turn.assistant }],
        timestamp: turn.timestamp ?? '2026-04-20T00:00:01.000Z',
      },
    }));
  }

  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

describe('session capture', () => {
  const dirs: string[] = [];
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('opens a real native queue runtime flow', () => {
    const dir = tempDir();
    dirs.push(dir);
    const result = openSessionCapture(openNativeStore({ baseDir: dir }), { baseDir: dir });

    expect((result.runtime as SessionCaptureRuntime).state().offset).toBe(0);
  });

  it('writes a checkpoint and buffers pending turns before the threshold', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const transcriptPath = join(dir, 'session.jsonl');
    writeEventTranscript(transcriptPath, [
      { id: 'turn-1', user: 'What changed in BYOMem?', assistant: 'We restored TS checkpoint capture.' },
    ]);
    const store = openNativeStore({ baseDir: dir });

    const result = await captureSessionCheckpoint(store, {
      baseDir: dir,
      thresholdTurns: 2,
      minTurns: 2,
      generation: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b' },
    }, {
      sessionId: 'session-alpha',
      transcriptPath,
      event: 'turn_end',
      final: false,
      idle: false,
      agent: 'assistant',
      model: 'gpt-5.4',
    });

    expect(result.reason).toBe('checkpointed');
    expect(result.pendingTurns).toBe(1);
    expect(result.rollup).toBeUndefined();
    expect(result.record).toMatchObject({
      identity: { namespace: 'byomem-session', leafName: 'session-alpha', parentContext: 'root' },
      provenance: { source: 'session-capture', adapter: 'native-store', origin: 'session-capture' },
      content: {
        text: 'Session session-alpha checkpoint from turn_end',
        structured: expect.objectContaining({ event: 'turn_end', pendingTurns: 1 }),
      },
    });
    expect(existsSync(join(dir, 'queue', 'session-capture-state.json'))).toBe(true);
    expect(store.list()).toHaveLength(1);
  });

  it('summarizes and writes a rollup once the threshold is reached', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const transcriptPath = join(dir, 'session.jsonl');
    const store = openNativeStore({ baseDir: dir });
    const calls: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify({ choices: [{ message: { content: '- Restored TS-native session capture\n- Added incremental rollups\nFinal: threshold flush complete.' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    writeEventTranscript(transcriptPath, [
      { id: 'turn-1', user: 'What changed in BYOMem?', assistant: 'We restored TS checkpoint capture.' },
    ]);
    await captureSessionCheckpoint(store, {
      baseDir: dir,
      thresholdTurns: 2,
      minTurns: 2,
      generation: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b' },
    }, {
      sessionId: 'session-alpha',
      transcriptPath,
      event: 'turn_end',
      final: false,
      idle: false,
      agent: 'assistant',
      model: 'gpt-5.4',
    });

    writeEventTranscript(transcriptPath, [
      { id: 'turn-1', user: 'What changed in BYOMem?', assistant: 'We restored TS checkpoint capture.' },
      { id: 'turn-2', user: 'Did qwen run?', assistant: 'It should run on threshold flushes.' },
    ]);
    const result = await captureSessionCheckpoint(store, {
      baseDir: dir,
      thresholdTurns: 2,
      minTurns: 2,
      generation: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b' },
    }, {
      sessionId: 'session-alpha',
      transcriptPath,
      event: 'turn_end',
      final: false,
      idle: false,
      agent: 'assistant',
      model: 'gpt-5.4',
    });

    expect(result.reason).toBe('threshold');
    expect(result.pendingTurns).toBe(0);
    expect(result.rollup).toMatchObject({
      identity: {
        namespace: 'byomem-session',
        parentContext: 'root',
      },
      provenance: { source: 'session-capture', adapter: 'native-store', origin: 'session-rollup' },
      content: {
        text: expect.stringContaining('threshold flush complete'),
        structured: {
          kind: 'rollup',
          sessionId: 'session-alpha',
          flushReason: 'threshold',
          pendingTurns: 2,
          pendingTurnIds: ['turn-1-user', 'turn-2-user'],
          sourceStableKey: 'project:byomem-session:root:session-alpha',
        },
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/v1/chat/completions');
    expect(calls[0]?.body).toMatchObject({ model: 'qwen3:8b' });
    expect(String(calls[0]?.body?.messages?.[1]?.content ?? '')).toContain('Turn 1 (turn-1-user)');
    expect(store.list().filter((record) => record.provenance.origin === 'session-rollup')).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, 'queue', 'session-capture-state.json'), 'utf8'))).toMatchObject({
      'session-alpha': {
        pendingTurns: [],
      },
    });
  });

  it('final flush summarizes only the remaining pending turns', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const transcriptPath = join(dir, 'session.jsonl');
    const store = openNativeStore({ baseDir: dir });
    const prompts: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ content?: string }> };
      prompts.push(String(body.messages?.[1]?.content ?? ''));
      return new Response(JSON.stringify({ choices: [{ message: { content: '- Incremental session summary\nFinal: flushed remaining pending turns.' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    writeEventTranscript(transcriptPath, [
      { id: 'turn-1', user: 'Turn one', assistant: 'Answer one' },
    ]);
    await captureSessionCheckpoint(store, {
      baseDir: dir,
      thresholdTurns: 2,
      minTurns: 2,
      generation: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b' },
    }, { sessionId: 'session-alpha', transcriptPath, event: 'turn_end', final: false, idle: false });

    writeEventTranscript(transcriptPath, [
      { id: 'turn-1', user: 'Turn one', assistant: 'Answer one' },
      { id: 'turn-2', user: 'Turn two', assistant: 'Answer two' },
    ]);
    await captureSessionCheckpoint(store, {
      baseDir: dir,
      thresholdTurns: 2,
      minTurns: 2,
      generation: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b' },
    }, { sessionId: 'session-alpha', transcriptPath, event: 'turn_end', final: false, idle: false });

    writeEventTranscript(transcriptPath, [
      { id: 'turn-1', user: 'Turn one', assistant: 'Answer one' },
      { id: 'turn-2', user: 'Turn two', assistant: 'Answer two' },
      { id: 'turn-3', user: 'Turn three', assistant: 'Answer three' },
    ]);
    const result = await captureSessionCheckpoint(store, {
      baseDir: dir,
      thresholdTurns: 2,
      minTurns: 2,
      generation: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b' },
    }, { sessionId: 'session-alpha', transcriptPath, event: 'session_shutdown', final: true, idle: false });

    expect(result.reason).toBe('final');
    expect(result.rollup?.content.structured).toMatchObject({
      kind: 'rollup',
      flushReason: 'final',
      pendingTurns: 1,
      pendingTurnIds: ['turn-3-user'],
    });
    expect(store.list().filter((record) => record.provenance.origin === 'session-rollup')).toHaveLength(2);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Turn 1 (turn-3-user)');
    expect(prompts[1]).not.toContain('turn-1-user');
    expect(prompts[1]).not.toContain('turn-2-user');
  });

  it('idle flush forces a summary for the remaining tail', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const transcriptPath = join(dir, 'session.jsonl');
    const store = openNativeStore({ baseDir: dir });
    globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '- Idle flush summary\nFinal sentence.' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    writeEventTranscript(transcriptPath, [
      { id: 'turn-1', user: 'Idle turn', assistant: 'Needs a summary now' },
    ]);
    const result = await captureSessionCheckpoint(store, {
      baseDir: dir,
      thresholdTurns: 3,
      minTurns: 2,
      generation: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b' },
    }, { sessionId: 'session-alpha', transcriptPath, event: 'session_before_switch', final: false, idle: true });

    expect(result.reason).toBe('idle');
    expect(result.rollup?.content.structured).toMatchObject({ kind: 'rollup', flushReason: 'idle', pendingTurns: 1 });
  });
});
