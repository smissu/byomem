import { afterEach, describe, expect, it, vi } from 'vitest';
import { openGenerationClient } from '../src/generation-client.js';

describe('generation client', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends chat/completions requests with the configured model', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'remote answer' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      const client = openGenerationClient({ baseUrl: 'http://localhost:11434', model: 'llama3.1', timeoutMs: 100 });
      const result = await client.generate({ prompt: 'hello world', system: 'system prompt', messages: [{ role: 'system', content: 'system prompt' }, { role: 'user', content: 'hello world' }] });
      expect(result).toBe('remote answer');
      expect(calls[0]?.url).toContain('/v1/chat/completions');
      expect(calls[0]?.body).toMatchObject({ model: 'llama3.1', messages: [{ role: 'system', content: 'system prompt' }, { role: 'user', content: 'hello world' }], temperature: 0 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses Ollama native chat when configured for summarizer-only request options', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify({ message: { content: 'remote answer' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      const client = openGenerationClient({
        baseUrl: 'http://localhost:11434/v1',
        model: 'qwen3:8b',
        transport: 'ollama-native-chat',
        requestOptions: { options: { num_ctx: 16384 } },
      });
      await client.generate({ prompt: 'summarize this' });
      expect(calls[0]?.url).toContain('/api/chat');
      expect(calls[0]?.body).toMatchObject({
        model: 'qwen3:8b',
        stream: false,
        options: { num_ctx: 16384 },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails fast on missing generation input', async () => {
    const client = openGenerationClient();
    await expect(client.generate({ prompt: '   ' })).rejects.toThrow('Missing generation input');
  });

  it('tries fallback model before local fallback when the primary remote request fails', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) });
      if (calls.length === 1) return new Response('nope', { status: 500, headers: { 'content-type': 'text/plain' } });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'fallback answer' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      const client = openGenerationClient({ baseUrl: 'http://localhost:11434', model: 'qwen3:8b', fallbackModel: 'qwen3.5:4b' });
      const result = await client.generate({ prompt: 'hello world' });
      expect(result).toBe('fallback answer');
      expect(calls).toHaveLength(2);
      expect(calls[0]?.body).toMatchObject({ model: 'qwen3:8b' });
      expect(calls[1]?.body).toMatchObject({ model: 'qwen3.5:4b' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('falls back to normalized text when remote generation is unavailable', async () => {
    const client = openGenerationClient();
    const result = await client.generate({ prompt: '   fallback text   ' });
    expect(result).toBe('fallback text');
  });
});
