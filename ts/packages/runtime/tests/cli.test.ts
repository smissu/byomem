import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-cli-'));
}

describe('runtime cli', () => {
  const dirs: string[] = [];
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('prints JSON usage for --help', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['--help']);
    expect(JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({ error: 'Usage', commands: expect.arrayContaining(['store', 'search', 'prune', 'generate']) });
  });

  it('prints JSON usage for generation errors', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await main(['generate']);
    expect(JSON.parse(String(errSpy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({ error: 'Missing --prompt, --text, or --messages for generate', command: 'generate', usage: { error: 'Usage' } });
  });

  it('does not open the store for generation-only commands', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['generate', '--prompt', 'hello']);
    expect(JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({ result: 'hello' });
  });

  it('fails closed for store when no embedding base URL is configured', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await main(['store', '--base-dir', dir, '--input', JSON.stringify({ scope: 'project', identity: { namespace: 'byomem', leafName: 'CLI Alpha', parentContext: 'root' }, content: { text: 'cli body' }, provenance: { source: 'fixtures' } })]);

    expect(JSON.parse(String(errSpy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      error: 'Remote embedding provider is required but no embedding base URL is configured',
      command: 'store',
    });
    expect(existsSync(join(dir, 'native-store.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'native-store.json'), 'utf8'))).toMatchObject({ version: 1, records: [] });
    expect(existsSync(join(dir, 'byomem-index.sqlite'))).toBe(true);
  });

  it('fails closed for store when remote embeddings return no usable vector', async () => {
    const dir = tempDir();
    dirs.push(dir);
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ nope: [0.1, 0.2, 0.3] }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await main(['store', '--base-dir', dir, '--embedding-base-url', 'http://localhost:11434/v1', '--embedding-model', 'nomic-embed-text', '--input', JSON.stringify({ scope: 'project', identity: { namespace: 'byomem', leafName: 'CLI Beta', parentContext: 'root' }, content: { text: 'cli body' }, provenance: { source: 'fixtures' } })]);

    expect(JSON.parse(String(errSpy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      error: 'Remote embedding request returned no embedding for model nomic-embed-text',
      command: 'store',
    });
    expect(existsSync(join(dir, 'native-store.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'native-store.json'), 'utf8'))).toMatchObject({ version: 1, records: [] });
  });

  it('store succeeds with a usable remote embedding response', async () => {
    const dir = tempDir();
    dirs.push(dir);
    globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['store', '--base-dir', dir, '--embedding-base-url', 'http://localhost:11434/v1', '--embedding-model', 'nomic-embed-text', '--input', JSON.stringify({ scope: 'project', identity: { namespace: 'byomem', leafName: 'CLI Gamma', parentContext: 'root' }, content: { text: 'cli body' }, provenance: { source: 'fixtures' } })]);

    expect(JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      record: {
        record: {
          scope: 'project',
          identity: { namespace: 'byomem', leafName: 'cli-gamma', parentContext: 'root' },
          provenance: { source: 'fixtures', origin: 'write' },
        },
      },
    });
    expect(existsSync(join(dir, 'native-store.json'))).toBe(true);
    expect(existsSync(join(dir, 'byomem-index.sqlite'))).toBe(true);
  });
});
