import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureSessionCheckpoint } from '../src/session-capture.js';
import { openNativeStore } from '../src/store.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-s64-transcript-'));
}

function writeCodexTranscript(path: string): void {
  writeFileSync(path, [
    JSON.stringify({ id: 'u1', role: 'user', content: [{ type: 'input_text', text: 'Please inspect sqlite schema' }], encrypted_content: 'user-secret' }),
    JSON.stringify({ id: 'tool-1', parentId: 'u1', type: 'function_call', name: 'shell', arguments: '{"cmd":"cat secret"}' }),
    JSON.stringify({ id: 'tool-out-1', parentId: 'tool-1', type: 'function_call_output', output: 'raw tool output should not appear' }),
    JSON.stringify({ id: 'a1', parentId: 'u1', role: 'assistant', content: [{ type: 'output_text', text: 'The schema uses records_fts and record_embeddings.' }], thinkingSignature: 'hidden-sig', reasoning: 'private reasoning' }),
    JSON.stringify({ id: 'u2', role: 'user', content: [{ type: 'input_text', text: 'Any next step?' }], encryptedContent: 'more-secret' }),
    JSON.stringify({ id: 'a2', parentId: 'u2', role: 'assistant', content: [{ type: 'output_text', text: 'Run a BYOMem scan after code changes.' }], textSignature: 'hidden-text-sig', image: { data: 'binary-like' } }),
  ].join('\n'), 'utf8');
}

describe('Sprint 64 Codex transcript sanitizer', () => {
  const dirs: string[] = [];
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
  });

  it('keeps only visible user and assistant text before durable rollup persistence', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const transcriptPath = join(dir, 'codex.jsonl');
    writeCodexTranscript(transcriptPath);
    const store = openNativeStore({ baseDir: dir });
    const prompts: string[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ content?: string }> };
      prompts.push(String(body.messages?.at(-1)?.content ?? ''));
      return new Response(JSON.stringify({ choices: [{ message: { content: '- Visible Codex session text was summarized\nFinal: sanitized rollup complete.' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const result = await captureSessionCheckpoint(store, {
      baseDir: dir,
      thresholdTurns: 2,
      minTurns: 2,
      generation: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b' },
    }, {
      sessionId: 'codex-session-alpha',
      transcriptPath,
      event: 'codex_stop',
      final: true,
      idle: false,
      agent: 'codex',
      model: 'gpt-5.4',
    });

    expect(result.reason).toBe('final');
    const rollup = result.rollup?.record;
    expect(rollup?.content.text).toContain('sanitized rollup complete');
    expect(prompts[0]).toContain('Please inspect sqlite schema');
    expect(prompts[0]).toContain('The schema uses records_fts and record_embeddings');
    expect(prompts[0]).toContain('Run a BYOMem scan after code changes');
    expect(prompts[0]).not.toContain('encrypted_content');
    expect(prompts[0]).not.toContain('encryptedContent');
    expect(prompts[0]).not.toContain('thinkingSignature');
    expect(prompts[0]).not.toContain('textSignature');
    expect(prompts[0]).not.toContain('private reasoning');
    expect(prompts[0]).not.toContain('raw tool output should not appear');
    expect(prompts[0]).not.toContain('binary-like');
    expect(JSON.stringify(rollup)).not.toContain('encrypted_content');
    expect(JSON.stringify(rollup)).not.toContain('encryptedContent');
    expect(JSON.stringify(rollup)).not.toContain('thinkingSignature');
    expect(JSON.stringify(rollup)).not.toContain('textSignature');
    expect(JSON.stringify(rollup)).not.toContain('private reasoning');
    expect(JSON.stringify(rollup)).not.toContain('raw tool output should not appear');
    expect(JSON.stringify(rollup)).not.toContain('binary-like');
  });

  it('captures ordered Codex role/content JSONL even when message ids are absent', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const transcriptPath = join(dir, 'codex-no-ids.jsonl');
    writeFileSync(transcriptPath, [
      JSON.stringify({ role: 'user', content: [{ type: 'input_text', text: 'Store the no-id Codex turn.' }], encrypted_content: 'secret' }),
      JSON.stringify({ role: 'assistant', content: [{ type: 'output_text', text: 'The no-id Codex turn was captured.' }], thinkingSignature: 'hidden' }),
    ].join('\n'), 'utf8');
    const store = openNativeStore({ baseDir: dir });

    const result = await captureSessionCheckpoint(store, {
      baseDir: dir,
      thresholdTurns: 1,
      minTurns: 1,
    }, {
      sessionId: 'codex-session-no-ids',
      transcriptPath,
      event: 'codex_stop',
      final: true,
      idle: false,
      agent: 'codex',
      model: 'gpt-5.4',
    });

    expect(result.reason).toBe('final');
    expect(result.rollup?.record?.content.text).toContain('Store the no-id Codex turn');
    expect(result.rollup?.record?.content.text).toContain('The no-id Codex turn was captured');
    expect(JSON.stringify(result.rollup?.record)).not.toContain('encrypted_content');
    expect(JSON.stringify(result.rollup?.record)).not.toContain('thinkingSignature');
  });

  it('captures live Codex response_item payload message wrappers', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const transcriptPath = join(dir, 'codex-live-wrapper.jsonl');
    writeFileSync(transcriptPath, [
      JSON.stringify({
        timestamp: '2026-05-07T11:03:20.842Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Why is Ollama not running?' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-05-07T11:03:48.121Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'The hook skipped because no pending turns were parsed.' }],
        },
      }),
    ].join('\n'), 'utf8');
    const store = openNativeStore({ baseDir: dir });

    const result = await captureSessionCheckpoint(store, {
      baseDir: dir,
      thresholdTurns: 1,
      minTurns: 1,
    }, {
      sessionId: 'codex-session-live-wrapper',
      transcriptPath,
      event: 'codex_stop',
      final: true,
      idle: false,
      agent: 'codex',
      model: 'gpt-5.4',
    });

    expect(result.reason).toBe('final');
    expect(result.rollup?.record?.content.text).toContain('Why is Ollama not running');
    expect(result.rollup?.record?.content.text).toContain('The hook skipped because');
  });
});
