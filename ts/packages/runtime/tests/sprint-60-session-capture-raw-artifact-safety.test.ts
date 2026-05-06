import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureSessionCheckpoint } from '../src/session-capture.js';
import { resolveSessionCaptureConfig } from '../src/readonly-core.js';
import { openNativeStore } from '../src/store.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-sprint-60-capture-safety-'));
}

describe('Sprint 60 session-capture raw artifact safety', () => {
  const dirs: string[] = [];
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('keeps session capture disabled by default until config explicitly enables it', () => {
    const dir = tempDir();
    dirs.push(dir);

    expect(resolveSessionCaptureConfig({ BYOMEM_CONFIG_PATH: join(dir, 'missing.yaml') } as never)).toMatchObject({
      source: 'default',
      enabled: false,
    });
  });

  it('redacts sensitive markers before summarizer input, fallback summaries, and durable rollups', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const transcriptPath = join(dir, 'session.jsonl');
    const store = openNativeStore({ baseDir: dir, embeddingModel: 'fallback-deterministic-v1' });
    const prompts: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ content?: string }> };
      prompts.push(String(body.messages?.at(-1)?.content ?? ''));
      throw new Error('force fallback summary');
    }) as typeof fetch;

    writeFileSync(transcriptPath, [
      'user: inspect {"thinkingSignature":"secret-user"}',
      'assistant: result has textSignature and {"encrypted_content":"opaque"}',
      'user: follow up',
      'assistant: encryptedContent should not persist',
    ].join('\n'), 'utf8');

    await captureSessionCheckpoint(store, {
      baseDir: dir,
      thresholdTurns: 2,
      minTurns: 2,
      generation: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b' },
    }, {
      sessionId: 'sprint-60-session',
      transcriptPath,
      event: 'turn_end',
    });

    expect(prompts.join('\n')).not.toMatch(/thinkingSignature|textSignature|encrypted_content|encryptedContent|secret-user|opaque/);
    expect(existsSync(join(dir, 'native-store.json'))).toBe(false);
    const rollup = store.list().find((record) => record.content.structured?.kind === 'rollup');
    expect(rollup?.content.text).not.toMatch(/thinkingSignature|textSignature|encrypted_content|encryptedContent|secret-user|opaque/);
    expect(Object.keys(rollup?.content.structured ?? {})).toEqual(['kind', 'sessionId', 'flushReason', 'sourceStableKey']);
    expect(existsSync(join(dir, 'queue', 'session-capture-state.json'))).toBe(true);
    store.close();
  });
});
