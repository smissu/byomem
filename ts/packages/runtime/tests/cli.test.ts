import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
    expect(JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({ error: 'Usage', commands: expect.arrayContaining(['store', 'search', 'file-search-scan', 'prune', 'generate']) });
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

  it('prints file-search scanner status without requiring a search query or starting a scan', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'status.txt'), 'scanner status body\n', 'utf8');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['file-search-status', '--base-dir', dir, '--json']);

    expect(JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      status: {
        state: 'idle',
        projectKey: expect.any(String),
        progress: expect.objectContaining({ indexedFiles: 0, chunksWritten: 0 }),
        database: expect.objectContaining({ indexedFiles: 0, indexedChunks: 0 }),
      },
    });
  });

  it('runs an explicit file-search scan without requiring a query or embedding server', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'scan-target.txt'), 'scan target body\n', 'utf8');
    globalThis.fetch = (async () => { throw new Error('file-search-scan must not request embeddings'); }) as typeof fetch;
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['file-search-scan', '--base-dir', dir, '--json']);

    expect(JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      scanner: {
        state: 'completed',
        trigger: 'manual',
        progress: expect.objectContaining({ indexedFiles: expect.any(Number), changedFiles: expect.any(Number) }),
        database: expect.objectContaining({ indexedFiles: 1, indexedChunks: expect.any(Number) }),
      },
      status: expect.objectContaining({ state: 'completed', trigger: 'manual' }),
    });
  });

  it('updates explicit file-search scan counters after file changes and deletions', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const changedPath = join(dir, 'changed.txt');
    const deletedPath = join(dir, 'deleted.txt');
    writeFileSync(changedPath, 'changed v1\n', 'utf8');
    writeFileSync(deletedPath, 'deleted v1\n', 'utf8');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['file-search-scan', '--base-dir', dir]);
    writeFileSync(changedPath, 'changed v2\nchanged second line\n', 'utf8');
    unlinkSync(deletedPath);
    await main(['file-search-scan', '--base-dir', dir]);

    expect(JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      scanner: {
        state: 'completed',
        trigger: 'manual',
        progress: expect.objectContaining({ changedFiles: expect.any(Number), deletedFiles: expect.any(Number) }),
        database: expect.objectContaining({ indexedFiles: 1 }),
      },
    });
    const status = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}')).scanner;
    expect(status.progress.changedFiles).toBeGreaterThanOrEqual(1);
    expect(status.progress.deletedFiles).toBeGreaterThanOrEqual(1);
  });

  it('runs file-search without embedding config by degrading default hybrid mode to FTS', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'lexical.txt'), 'lexical only body\n', 'utf8');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['file-search', '--base-dir', dir, '--query', 'lexical']);

    expect(JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      results: [expect.objectContaining({ file: expect.objectContaining({ path: expect.stringContaining('lexical.txt') }) })],
    });
  });

  it('honors file-search --limit for bounded result output', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'alpha-one.txt'), 'alpha shared term one\n', 'utf8');
    writeFileSync(join(dir, 'alpha-two.txt'), 'alpha shared term two\n', 'utf8');
    writeFileSync(join(dir, 'alpha-three.txt'), 'alpha shared term three\n', 'utf8');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['file-search', '--base-dir', dir, '--mode', 'fts', '--query', 'alpha', '--limit', '1']);

    const output = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(output.results).toHaveLength(1);
  });

  it('rejects invalid file-search --limit values before opening or scanning the file-search DB', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    for (const invalidLimit of ['0', '-1', '1.5', 'nope', '1.0', '01', '1e2', '0x10']) {
      const dir = tempDir();
      dirs.push(dir);
      writeFileSync(join(dir, 'alpha.txt'), 'alpha body\n', 'utf8');

      await main(['file-search', '--base-dir', dir, '--mode', 'fts', '--query', 'alpha', '--limit', invalidLimit]);

      expect(JSON.parse(String(errSpy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
        error: '--limit must be a positive integer',
        command: 'file-search',
      });
      expect(existsSync(join(dir, 'byomem-file-search.sqlite'))).toBe(false);
      process.exitCode = undefined;
    }
  });

  it('runs semantic file-search through the public CLI surface', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'alpha.txt'), 'alpha target body\n', 'utf8');
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { prompt?: string };
      const embedding = body.prompt?.includes('meaning query') || body.prompt?.includes('alpha target') ? [1, 0, 0] : [0, 1, 0];
      return new Response(JSON.stringify({ embedding }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['file-search', '--base-dir', dir, '--embedding-base-url', 'http://localhost:11434', '--semantic-file-search', '--mode', 'semantic', '--query', 'meaning query']);

    expect(JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      results: [expect.objectContaining({ file: expect.objectContaining({ path: expect.stringContaining('alpha.txt') }) })],
    });
  });
});
