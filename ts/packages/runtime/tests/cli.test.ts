import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { openFileSearchDb } from '../src/file-search-db.js';
import { listFileSearchProjects } from '../src/file-search-project-registry.js';
import { openNativeStore } from '../src/store.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-cli-'));
}

function indexedPaths(dir: string): string[] {
  const fileDb = openFileSearchDb({ baseDir: dir, scanOnOpen: false, schedulerEnabled: false, semanticSearchEnabled: false });
  try {
    return (fileDb.db.prepare('SELECT path FROM indexed_files ORDER BY path').all() as Array<{ path: string }>).map((row) => row.path);
  } finally {
    fileDb.close();
  }
}

function storedMemoryIds(dir: string): string[] {
  const store = openNativeStore({ baseDir: dir, embeddingModel: 'fallback-deterministic-v1' });
  try {
    return store.list().map((record) => record.id);
  } finally {
    store.close();
  }
}

describe('runtime cli', () => {
  const dirs: string[] = [];
  const originalFetch = globalThis.fetch;
  const originalRuntimeBase = process.env.BYOMEM_RUNTIME_BASE_DIR;

  beforeEach(() => {
    const runtimeDir = tempDir();
    dirs.push(runtimeDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
  });

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    if (originalRuntimeBase === undefined) delete process.env.BYOMEM_RUNTIME_BASE_DIR;
    else process.env.BYOMEM_RUNTIME_BASE_DIR = originalRuntimeBase;
    process.exitCode = undefined;
  });

  it('prints JSON usage for --help', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['--help']);
    expect(JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({ error: 'Usage', commands: expect.arrayContaining(['store', 'search', 'connect codex', 'file-search-scan', 'prune', 'generate', 'status', 'doctor']) });
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
    expect(existsSync(join(dir, 'native-store.json'))).toBe(false);
    expect(existsSync(join(dir, 'byomem-index.sqlite'))).toBe(true);
    expect(storedMemoryIds(dir)).toEqual([]);
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
    expect(existsSync(join(dir, 'native-store.json'))).toBe(false);
    expect(existsSync(join(dir, 'byomem-index.sqlite'))).toBe(true);
    expect(storedMemoryIds(dir)).toEqual([]);
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
    expect(existsSync(join(dir, 'native-store.json'))).toBe(false);
    expect(existsSync(join(dir, 'byomem-index.sqlite'))).toBe(true);
    expect(storedMemoryIds(dir)).toContain('project:byomem:root:cli-gamma');
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

  it('does not add registry entries for status-only file-search calls', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'status-only.txt'), 'status only body\n', 'utf8');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['file-search-status', '--base-dir', dir, '--json']);

    const payload = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(payload.status.database).not.toHaveProperty('projects');
    const store = openFileSearchDb({ baseDir: dir, scanOnOpen: false });
    try {
      expect(listFileSearchProjects(store.db)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('runs an explicit file-search scan without requiring a query or embedding server', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'scan-target.txt'), 'scan target body\n', 'utf8');
    globalThis.fetch = (async () => { throw new Error('file-search-scan must not request embeddings'); }) as typeof fetch;
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['file-search-scan', '--base-dir', dir, '--file-search-include-text-files', 'true', '--json']);

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

  it('rejects file-search-scan --async deterministically without opening a hidden worker', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'async-cli.txt'), 'async cli body\n', 'utf8');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await main(['file-search-scan', '--base-dir', dir, '--file-search-include-text-files', 'true', '--async', '--json']);

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(String(errSpy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      error: expect.stringContaining('async-scan-runtime-local-only'),
      command: 'file-search-scan',
    });
    expect(existsSync(join(dir, 'byomem-file-search.sqlite'))).toBe(false);
  });

  it('honors file-search scanner flags for explicit replacement semantics and binary opt-out', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'keep.txt'), 'keep body\n', 'utf8');
    writeFileSync(join(dir, 'keep.db'), 'keep db body\n', 'utf8');
    writeFileSync(join(dir, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0x61, 0x62, 0x63]));
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['file-search-scan', '--base-dir', dir, '--file-search-include-text-files', 'true', '--json']);
    expect(JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      scanner: {
        progress: expect.objectContaining({ errorFiles: 0 }),
        database: expect.objectContaining({ indexedFiles: 1 }),
      },
    });
    expect(indexedPaths(dir)).toEqual([join(dir, 'keep.txt')]);

    await main(['file-search-scan', '--base-dir', dir, '--file-search-include-text-files', 'true', '--file-search-excluded-extensions', 'txt', '--file-search-binary-detection', 'false', '--json']);
    expect(JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      scanner: {
        progress: expect.objectContaining({ errorFiles: 0, deletedFiles: expect.any(Number) }),
      },
    });
    expect(indexedPaths(dir)).toEqual(expect.arrayContaining([join(dir, 'keep.db'), join(dir, 'binary.bin')]));
    expect(indexedPaths(dir)).not.toEqual(expect.arrayContaining([join(dir, 'keep.txt')]));
  });

  it('treats an explicitly empty file-search exclusion env var as disabling defaults', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'keep.txt'), 'keep body\n', 'utf8');
    writeFileSync(join(dir, 'keep.db'), 'keep db body\n', 'utf8');
    const originalExcludedExtensions = process.env.BYOMEM_FILE_SEARCH_EXCLUDED_EXTENSIONS;
    process.env.BYOMEM_FILE_SEARCH_EXCLUDED_EXTENSIONS = '';
    try {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await main(['file-search-scan', '--base-dir', dir, '--file-search-include-text-files', 'true', '--json']);

      expect(JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
        scanner: {
          progress: expect.objectContaining({ errorFiles: 0 }),
          database: expect.objectContaining({ indexedFiles: 2 }),
        },
      });
      expect(indexedPaths(dir)).toEqual(expect.arrayContaining([join(dir, 'keep.txt'), join(dir, 'keep.db')]));
    } finally {
      if (originalExcludedExtensions === undefined) delete process.env.BYOMEM_FILE_SEARCH_EXCLUDED_EXTENSIONS;
      else process.env.BYOMEM_FILE_SEARCH_EXCLUDED_EXTENSIONS = originalExcludedExtensions;
    }
  });

  it('updates explicit file-search scan counters after file changes and deletions', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const changedPath = join(dir, 'changed.txt');
    const deletedPath = join(dir, 'deleted.txt');
    writeFileSync(changedPath, 'changed v1\n', 'utf8');
    writeFileSync(deletedPath, 'deleted v1\n', 'utf8');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['file-search-scan', '--base-dir', dir, '--file-search-include-text-files', 'true']);
    writeFileSync(changedPath, 'changed v2\nchanged second line\n', 'utf8');
    unlinkSync(deletedPath);
    await main(['file-search-scan', '--base-dir', dir, '--file-search-include-text-files', 'true']);

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

  it('runs file-search without embedding config by default in hybrid mode', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'lexical.txt'), 'lexical only body\n', 'utf8');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['file-search-scan', '--base-dir', dir, '--file-search-include-text-files', 'true']);
    await main(['file-search', '--base-dir', dir, '--file-search-include-text-files', 'true', '--query', 'lexical']);

    expect(JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      results: [expect.objectContaining({ chunk: expect.objectContaining({ filePath: expect.stringContaining('lexical.txt') }) })],
    });
  });

  it('does not hidden-refresh semantic file-search before an explicit scan', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'alpha.txt'), 'alpha target body\n', 'utf8');
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ embedding: [1, 0, 0] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main([
      'file-search',
      '--base-dir', dir,
      '--file-search-include-text-files', 'true',
      '--mode', 'semantic',
      '--query', 'alpha target body',
      '--embedding-base-url', 'http://localhost:11434',
      '--embedding-model', 'cli-model',
      '--embedding-dimension', '3',
    ]);

    expect(JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      results: [],
      semantic: expect.objectContaining({ requested: true, used: false, state: 'ready', refreshNeeded: false }),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('honors file-search --limit for bounded result output', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'alpha-one.txt'), 'alpha shared term one\n', 'utf8');
    writeFileSync(join(dir, 'alpha-two.txt'), 'alpha shared term two\n', 'utf8');
    writeFileSync(join(dir, 'alpha-three.txt'), 'alpha shared term three\n', 'utf8');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['file-search-scan', '--base-dir', dir, '--file-search-include-text-files', 'true']);
    await main(['file-search', '--base-dir', dir, '--file-search-include-text-files', 'true', '--mode', 'bm25', '--query', 'alpha', '--limit', '1']);

    const output = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(output.results).toHaveLength(1);
  });

  it('rejects invalid file-search --limit values before opening or scanning the file-search DB', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    for (const invalidLimit of ['0', '-1', '1.5', 'nope', '1.0', '01', '1e2', '0x10']) {
      const dir = tempDir();
      dirs.push(dir);
      writeFileSync(join(dir, 'alpha.txt'), 'alpha body\n', 'utf8');

      await main(['file-search', '--base-dir', dir, '--file-search-include-text-files', 'true', '--mode', 'bm25', '--query', 'alpha', '--limit', invalidLimit]);

      expect(JSON.parse(String(errSpy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
        error: '--limit must be a positive integer',
        command: 'file-search',
      });
      expect(existsSync(join(dir, 'byomem-file-search.sqlite'))).toBe(false);
      process.exitCode = undefined;
    }
  });

  it('runs semantic file-search through the public CLI surface after scan refreshes embeddings', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'alpha.txt'), 'alpha target body\n', 'utf8');
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { prompt?: string };
      const embedding = body.prompt?.includes('meaning query') || body.prompt?.includes('alpha target') ? [1, 0, 0] : [0, 1, 0];
      return new Response(JSON.stringify({ embedding }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['file-search-scan', '--base-dir', dir, '--file-search-include-text-files', 'true', '--embedding-base-url', 'http://localhost:11434', '--embedding-dimension', '3', '--file-search-embedding-concurrency', '2']);
    expect(JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      refresh: expect.objectContaining({ automatic: true, attempted: true }),
      embeddings: expect.objectContaining({ state: 'ready', embeddedChunks: expect.any(Number), refreshNeededChunks: 0 }),
    });
    await main(['file-search', '--base-dir', dir, '--file-search-include-text-files', 'true', '--mode', 'semantic', '--query', 'meaning query', '--embedding-base-url', 'http://localhost:11434', '--embedding-dimension', '3']);

    expect(JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      results: [expect.objectContaining({ chunk: expect.objectContaining({ filePath: expect.stringContaining('alpha.txt') }) })],
    });
  });

  it('runs file-search-related through the public CLI surface', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'seed.txt'), 'seed alpha line\n\nseed beta line\n', 'utf8');
    writeFileSync(join(dir, 'neighbor.txt'), 'seed alpha related neighbor line\n', 'utf8');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['file-search-scan', '--base-dir', dir, '--file-search-include-text-files', 'true']);
    await main(['file-search-related', '--base-dir', dir, '--file-search-include-text-files', 'true', '--file-path', join(dir, 'seed.txt'), '--line', '1']);

    expect(JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      results: [expect.objectContaining({ chunk: expect.objectContaining({ filePath: join(dir, 'neighbor.txt') }) })],
    });
  });

  it('honors file-search index storage mode memory for explicit scans', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'memory.txt'), 'memory storage body\n', 'utf8');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await main(['file-search-scan', '--base-dir', dir, '--file-search-include-text-files', 'true', '--file-search-index-storage-mode', 'memory', '--json']);

    expect(JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      scanner: {
        state: 'completed',
      },
    });
    expect(existsSync(join(dir, 'byomem-file-search.sqlite'))).toBe(false);
  });

  it('registers, unregisters, and lists file-search projects explicitly without requiring memories or embeddings', async () => {
    const parentA = tempDir();
    const parentB = tempDir();
    dirs.push(parentA, parentB);
    const projectB = join(parentB, 'same-project');
    const projectA = join(parentA, 'same-project');
    writeFileSync(join(parentA, 'parent-a-sentinel.txt'), 'parent a sentinel\n', 'utf8');
    writeFileSync(join(parentB, 'parent-b-sentinel.txt'), 'parent b sentinel\n', 'utf8');
    // Parent directories exist from tempDir(); nested projects intentionally have the same basename.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    globalThis.fetch = (async () => { throw new Error('registry commands must not request embeddings'); }) as typeof fetch;

    await main(['file-search-project-register', '--base-dir', projectB, '--json']);
    expect(process.exitCode).toBeUndefined();
    const registeredB = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(registeredB).toMatchObject({
      project: {
        project_key: expect.stringMatching(/^project:same-project-[a-f0-9]{12}$/),
        base_dir: projectB,
        display_name: 'same-project',
        state: 'enabled',
        source: 'manual-register',
        created_at: expect.any(String),
        updated_at: expect.any(String),
        last_seen_at: expect.any(String),
        registered_at: expect.any(String),
      },
    });

    await main(['file-search-project-register', '--base-dir', projectA, '--json']);
    const registeredA = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(registeredA.project.project_key).not.toBe(registeredB.project.project_key);

    await main(['file-search-project-unregister', '--base-dir', projectB, '--json']);
    expect(JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      project: { base_dir: projectB, state: 'disabled', source: 'manual-unregister' },
    });

    await main(['file-search-project-list', '--json']);
    const listed = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}'));
    expect(listed.projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ base_dir: projectA, state: 'enabled', source: 'manual-register' }),
      expect.objectContaining({ base_dir: projectB, state: 'disabled', source: 'manual-unregister' }),
    ]));
    expect(listed.projects.map((entry: { base_dir: string }) => entry.base_dir)).toEqual([projectA, projectB].sort());
    expect(existsSync(join(projectA, 'native-store.json'))).toBe(false);
    expect(existsSync(join(projectA, 'byomem-index.sqlite'))).toBe(false);
    expect(existsSync(join(projectA, 'byomem-file-search.sqlite'))).toBe(false);
    expect(existsSync(join(projectB, 'native-store.json'))).toBe(false);
    expect(existsSync(join(projectB, 'byomem-index.sqlite'))).toBe(false);
    expect(existsSync(join(projectB, 'byomem-file-search.sqlite'))).toBe(false);
  });

  it('file-search project registry CLI requires explicit base-dir for register and unregister', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await main(['file-search-project-register', '--json']);
    expect(JSON.parse(String(errSpy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      error: 'Missing --base-dir for file-search-project-register',
      command: 'file-search-project-register',
    });
    process.exitCode = undefined;

    await main(['file-search-project-unregister', '--json']);
    expect(JSON.parse(String(errSpy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      error: 'Missing --base-dir for file-search-project-unregister',
      command: 'file-search-project-unregister',
    });
  });

  it('file-search project registry CLI is idempotent, soft-disables rows, and never starts polling or scans', async () => {
    const dir = tempDir();
    dirs.push(dir);
    writeFileSync(join(dir, 'not-scanned.txt'), 'registry commands must not scan this file\n', 'utf8');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    globalThis.fetch = (async () => { throw new Error('registry commands must not request embeddings'); }) as typeof fetch;

    await main(['file-search-project-register', '--base-dir', join(dir, '.'), '--json']);
    const first = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}')).project;
    await main(['file-search-project-register', '--base-dir', dir, '--json']);
    const second = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}')).project;
    expect(second).toMatchObject({ project_key: first.project_key, base_dir: dir, state: 'enabled', source: 'manual-register' });

    await main(['file-search-project-unregister', '--base-dir', dir, '--json']);
    const disabled = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}')).project;
    expect(disabled).toMatchObject({ project_key: first.project_key, base_dir: dir, state: 'disabled', source: 'manual-unregister' });

    await main(['file-search-project-list', '--json']);
    const listed = JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}')).projects;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ project_key: first.project_key, base_dir: dir, state: 'disabled' });

    const runtimeFileSearchDb = join(process.env.BYOMEM_RUNTIME_BASE_DIR ?? '', 'byomem-file-search.sqlite');
    expect(existsSync(runtimeFileSearchDb)).toBe(true);
    expect(existsSync(join(dir, 'byomem-file-search.sqlite'))).toBe(false);
    // Registry commands may create only the registry DB/table; they must not scan/index project files, create memory stores, or start scheduler timers.
    expect(existsSync(join(dir, 'native-store.json'))).toBe(false);
    expect(existsSync(join(dir, 'byomem-index.sqlite'))).toBe(false);
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

});
