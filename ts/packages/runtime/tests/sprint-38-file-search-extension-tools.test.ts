import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFileSearchDb } from '../src/file-search-db.js';

function tempDir(prefix = 'byomem-s38-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

type RegisteredTool = {
  name: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  execute: (...args: any[]) => Promise<unknown>;
};

function makeMockPi() {
  const tools: RegisteredTool[] = [];
  const commands: Record<string, { description: string; handler: (...args: any[]) => Promise<void> }> = {};
  const events: Record<string, Array<(...args: any[]) => any>> = {};
  return {
    tools,
    commands,
    events,
    api: {
      on(name: string, handler: (...args: any[]) => any) {
        events[name] ??= [];
        events[name].push(handler);
      },
      registerTool(tool: RegisteredTool) {
        tools.push(tool);
      },
      registerCommand(name: string, command: { description: string; handler: (...args: any[]) => Promise<void> }) {
        commands[name] = command;
      },
    },
  };
}

async function loadExtension() {
  vi.resetModules();
  return import('../src/pi-extension.ts');
}

describe('Sprint 38 file-search extension direct tool contract RED tests', () => {
  const dirs: string[] = [];
  const originalRuntimeBase = process.env.BYOMEM_RUNTIME_BASE_DIR;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    if (originalRuntimeBase === undefined) delete process.env.BYOMEM_RUNTIME_BASE_DIR;
    else process.env.BYOMEM_RUNTIME_BASE_DIR = originalRuntimeBase;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('registers the six direct file-search tools with strict schemas', async () => {
    const mod = await loadExtension();
    const mock = makeMockPi();
    mod.default(mock.api as never);

    expect(mock.tools.map((tool) => tool.name)).toEqual([
      'byomem_runtime_status',
      'byomem_search',
      'byomem_store',
      'byomem_prune',
      'byomem_file_search',
      'byomem_file_search_find_related',
      'byomem_file_search_semantic_refresh',
      'byomem_file_search_status',
      'byomem_file_search_scan',
      'byomem_file_search_polling_status',
      'byomem_file_search_polling_enable',
      'byomem_file_search_polling_disable',
      'byomem_file_search_project_register',
      'byomem_file_search_project_list',
      'byomem_file_search_project_unregister',
    ]);

    expect(mock.tools.find((tool) => tool.name === 'byomem_file_search')?.parameters).toEqual({
      type: 'object',
      properties: {
        query: { type: 'string' },
        mode: { type: 'string', enum: ['fts', 'semantic', 'hybrid'] },
        limit: { type: 'integer', minimum: 1 },
        baseDir: { type: 'string' },
      },
      required: ['query'],
      additionalProperties: false,
    });
    expect(mock.tools.find((tool) => tool.name === 'byomem_file_search_find_related')?.parameters).toEqual({
      type: 'object',
      properties: {
        filePath: { type: 'string' },
        line: { type: 'integer', minimum: 1 },
        limit: { type: 'integer', minimum: 1 },
        baseDir: { type: 'string' },
      },
      required: ['filePath', 'line'],
      additionalProperties: false,
    });
    expect(mock.tools.find((tool) => tool.name === 'byomem_file_search_status')?.parameters).toEqual({
      type: 'object',
      properties: { baseDir: { type: 'string' }, jobId: { type: 'string' } },
      additionalProperties: false,
    });
    expect(mock.tools.find((tool) => tool.name === 'byomem_file_search_scan')?.parameters).toEqual({
      type: 'object',
      properties: { baseDir: { type: 'string' }, async: { type: 'boolean' }, wait: { type: 'boolean' } },
      additionalProperties: false,
    });
    expect(mock.tools.find((tool) => tool.name === 'byomem_file_search_project_register')?.parameters).toEqual({
      type: 'object',
      properties: { baseDir: { type: 'string' } },
      required: ['baseDir'],
      additionalProperties: false,
    });
    expect(mock.tools.find((tool) => tool.name === 'byomem_file_search_project_list')?.parameters).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
    expect(mock.tools.find((tool) => tool.name === 'byomem_file_search_project_unregister')?.parameters).toEqual({
      type: 'object',
      properties: { baseDir: { type: 'string' } },
      required: ['baseDir'],
      additionalProperties: false,
    });
  });

  it('rejects blank or missing active project resolution for file-search tools instead of falling back to runtime storage', async () => {
    const noProjectDir = tempDir('byomem-s38-no-project-');
    dirs.push(noProjectDir);
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(noProjectDir);
    const mod = await loadExtension();
    const mock = makeMockPi();
    mod.default(mock.api as never);

    const searchTool = mock.tools.find((tool) => tool.name === 'byomem_file_search')!;
    await expect(searchTool.execute('2', { query: 'needle', baseDir: '   ' })).rejects.toThrow(/baseDir/i);
    cwdSpy.mockRestore();
  });

  it('validates query, mode, and positive integer limit for byomem_file_search', async () => {
    const validateDir = tempDir('byomem-s38-validate-');
    dirs.push(validateDir);
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(validateDir);
    const mod = await loadExtension();
    const mock = makeMockPi();
    mod.default(mock.api as never);

    const searchTool = mock.tools.find((tool) => tool.name === 'byomem_file_search')!;
    await expect(searchTool.execute('1', {})).rejects.toThrow(/query/i);
    await expect(searchTool.execute('2', { query: '   ' })).rejects.toThrow(/query/i);
    await expect(searchTool.execute('3', { query: 'needle', mode: 'lexical' })).rejects.toThrow(/mode/i);
    await expect(searchTool.execute('4', { query: 'needle', limit: 0 })).rejects.toThrow(/limit/i);
    await expect(searchTool.execute('5', { query: 'needle', limit: 1.5 })).rejects.toThrow(/limit/i);
    await expect(searchTool.execute('6', { query: 'needle', limit: '2' })).rejects.toThrow(/limit/i);
    cwdSpy.mockRestore();
  });

  it('keeps same-basename projects isolated and does not implicitly scan or refresh semantic embeddings on file search', async () => {
    const projectA = tempDir('byomem-s38-a-');
    const projectB = tempDir('byomem-s38-b-');
    dirs.push(projectA, projectB);
    writeFileSync(join(projectA, 'same.txt'), 'alpha same basename body\n', 'utf8');
    writeFileSync(join(projectB, 'same.txt'), 'beta same basename body\n', 'utf8');
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', tempDir('byomem-s38-runtime-'));

    const mod = await loadExtension();
    const mock = makeMockPi();
    mod.default(mock.api as never);

    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ embedding: [1, 0, 0] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const searchTool = mock.tools.find((tool) => tool.name === 'byomem_file_search')!;
    const result = await searchTool.execute('1', { query: 'same', baseDir: projectA, mode: 'hybrid', limit: 5 }) as { results?: Array<{ file?: { path?: string; project_key?: string } }> };

    expect(result).toMatchObject({ results: expect.any(Array) });
    expect((result.results ?? []).every((hit) => hit.file && typeof hit.file.project_key === 'string')).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(join(projectA, 'byomem-index.sqlite'))).toBe(false);
    expect(existsSync(join(projectB, 'byomem-index.sqlite'))).toBe(false);
  });

  it('returns scanner status and manual scan shapes without scheduler timers or scan side effects from status', async () => {
    const projectDir = tempDir('byomem-s38-status-');
    dirs.push(projectDir);
    writeFileSync(join(projectDir, 'status.txt'), 'status body\n', 'utf8');

    const mod = await loadExtension();
    const mock = makeMockPi();
    mod.default(mock.api as never);

    const statusTool = mock.tools.find((tool) => tool.name === 'byomem_file_search_status')!;
    const scanTool = mock.tools.find((tool) => tool.name === 'byomem_file_search_scan')!;

    const status = await statusTool.execute('1', { baseDir: projectDir }) as { scanner?: Record<string, unknown>; status?: Record<string, unknown> };
    expect(status).toMatchObject({ scanner: expect.any(Object), status: expect.any(Object) });
    expect(status.status).not.toHaveProperty('database.projects');
    expect(status.scanner).not.toHaveProperty('database.projects');
    expect(existsSync(join(projectDir, 'native-store.json'))).toBe(false);

    const scan = await scanTool.execute('2', { baseDir: projectDir }) as { scanner?: Record<string, unknown>; status?: Record<string, unknown> };
    expect(scan).toMatchObject({ scanner: expect.any(Object), status: expect.any(Object) });
    expect(scan.status).not.toHaveProperty('database.projects');
    expect(scan.scanner).not.toHaveProperty('database.projects');
  });

  it('supports explicit runtime-local async scan enqueue and status lookup without changing default scan behavior', async () => {
    const projectDir = tempDir('byomem-s38-s43-async-');
    const runtimeDir = tempDir('byomem-s38-s43-runtime-');
    dirs.push(projectDir, runtimeDir);
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', runtimeDir);
    writeFileSync(join(projectDir, 'async.txt'), 'async body\n', 'utf8');

    const mod = await loadExtension();
    const mock = makeMockPi();
    mod.default(mock.api as never);

    const scanTool = mock.tools.find((tool) => tool.name === 'byomem_file_search_scan')!;
    const statusTool = mock.tools.find((tool) => tool.name === 'byomem_file_search_status')!;

    const enqueue = await scanTool.execute('1', { baseDir: projectDir, async: true }) as { job?: { job_id?: string; state?: string; durable?: boolean }; scanner?: { state?: string } | null; runtime_local?: boolean; durable?: boolean };
    expect(enqueue).toMatchObject({
      runtime_local: true,
      durable: false,
      job: { job_id: expect.stringMatching(/^runtime-scan-/), state: 'queued', durable: false },
    });

    const byJob = await statusTool.execute('2', { jobId: enqueue.job?.job_id }) as { job_status?: { found?: boolean }; job?: { job_id?: string } };
    expect(byJob).toMatchObject({ job_status: { found: true }, job: { job_id: enqueue.job?.job_id } });

    await new Promise((resolve) => setTimeout(resolve, 10));
    const completed = await statusTool.execute('3', { jobId: enqueue.job?.job_id }) as { job?: { state?: string; scanner?: { state?: string; database?: { indexedFiles?: number } } } };
    expect(['running', 'completed']).toContain(completed.job?.state);
    if (completed.job?.state === 'completed') {
      expect(completed.job.scanner).toMatchObject({ state: 'completed', database: expect.objectContaining({ indexedFiles: 1 }) });
    }
  });

  it('skips default database extensions and binary content through the direct Pi scan tool', async () => {
    const projectDir = tempDir('byomem-s38-scan-');
    const runtimeDir = tempDir('byomem-s38-scan-runtime-');
    dirs.push(projectDir, runtimeDir);
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', runtimeDir);
    writeFileSync(join(projectDir, 'keep.txt'), 'keep body\n', 'utf8');
    writeFileSync(join(projectDir, 'artifact.db'), 'artifact body\n', 'utf8');
    writeFileSync(join(projectDir, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02, 0x61, 0x62, 0x63]));

    const mod = await loadExtension();
    const mock = makeMockPi();
    mod.default(mock.api as never);

    const scanTool = mock.tools.find((tool) => tool.name === 'byomem_file_search_scan')!;
    const result = await scanTool.execute('1', { baseDir: projectDir }) as { scanner?: { progress?: { ignoredFiles?: number; errorFiles?: number } } };

    const fileDb = openFileSearchDb({ baseDir: projectDir, dbBaseDir: runtimeDir, scanOnOpen: false, schedulerEnabled: false, semanticSearchEnabled: false });
    try {
      const indexedPaths = (fileDb.db.prepare('SELECT path FROM indexed_files ORDER BY path').all() as Array<{ path: string }>).map((row) => row.path);
      expect(indexedPaths).toEqual([join(projectDir, 'keep.txt')]);
      expect(result.scanner?.progress).toMatchObject({ ignoredFiles: expect.any(Number), errorFiles: 0 });
      expect(result.scanner?.progress?.ignoredFiles).toBeGreaterThanOrEqual(2);
    } finally {
      fileDb.close();
    }
  });

  it('does not create a registry row when file-search status is invoked for a previously unseen temp baseDir', async () => {
    const projectDir = tempDir('byomem-s38-unseen-status-');
    dirs.push(projectDir);
    writeFileSync(join(projectDir, 'unseen.txt'), 'unseen status body\n', 'utf8');
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', tempDir('byomem-s38-unseen-runtime-'));

    const mod = await loadExtension();
    const mock = makeMockPi();
    mod.default(mock.api as never);

    const statusTool = mock.tools.find((tool) => tool.name === 'byomem_file_search_status')!;
    await statusTool.execute('1', { baseDir: projectDir });

    const listTool = mock.tools.find((tool) => tool.name === 'byomem_file_search_project_list')!;
    const listResult = await listTool.execute('2', {}) as { content: { text: string }[]; details?: { projects?: Array<{ base_dir?: string }> } };
    const projects = listResult.details?.projects ?? JSON.parse(listResult.content[0].text).projects ?? [];
    expect(projects).toEqual([]);
    expect(projects).not.toEqual(expect.arrayContaining([expect.objectContaining({ base_dir: projectDir })]));
  });

  it('register/list/unregister tools require explicit baseDir on register/unregister and do not enable registry from memory tools', async () => {
    const projectDir = tempDir('byomem-s38-registry-');
    const runtimeDir = tempDir('byomem-s38-registry-runtime-');
    dirs.push(projectDir, runtimeDir);
    writeFileSync(join(projectDir, 'registry.txt'), 'registry body\n', 'utf8');
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', runtimeDir);

    const mod = await loadExtension();
    const mock = makeMockPi();
    mod.default(mock.api as never);

    const registerTool = mock.tools.find((tool) => tool.name === 'byomem_file_search_project_register')!;
    const listTool = mock.tools.find((tool) => tool.name === 'byomem_file_search_project_list')!;
    const unregisterTool = mock.tools.find((tool) => tool.name === 'byomem_file_search_project_unregister')!;
    const storeTool = mock.tools.find((tool) => tool.name === 'byomem_store')!;

    await expect(registerTool.execute('1', {})).rejects.toThrow(/baseDir/i);
    await expect(registerTool.execute('2', { baseDir: '   ' })).rejects.toThrow(/baseDir/i);
    await expect(unregisterTool.execute('3', {})).rejects.toThrow(/baseDir/i);
    await expect(unregisterTool.execute('4', { baseDir: '   ' })).rejects.toThrow(/baseDir/i);

    const listResult = await listTool.execute('5', {}) as { content: { text: string }[]; details?: { projects?: unknown[] } };
    const list = listResult.details ?? JSON.parse(listResult.content[0].text) as { projects?: unknown[] };
    expect(list).toMatchObject({ projects: expect.any(Array) });

    await storeTool.execute('6', {
      scope: 'project',
      identity: { namespace: 's38', leafName: 'memory-regression', parentContext: 'root' },
      content: { text: 'memory tool should not create file-search registry entries' },
      provenance: { source: 'test' },
    });
    expect(list.projects ?? []).toEqual([]);
    expect(existsSync(join(projectDir, 'byomem-file-search.sqlite'))).toBe(false);
  });

  it('does not return raw sensitive file-search markers from direct tool output when stale index rows exist', async () => {
    const projectDir = tempDir('byomem-s38-sensitive-project-');
    const runtimeDir = tempDir('byomem-s38-sensitive-runtime-');
    dirs.push(projectDir, runtimeDir);
    writeFileSync(join(projectDir, 'stale.txt'), 'ordinary stale searchable content\n', 'utf8');
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', runtimeDir);

    const fileDb = openFileSearchDb({ baseDir: projectDir, dbBaseDir: runtimeDir, scanOnOpen: false, schedulerEnabled: false, semanticSearchEnabled: false });
    try {
      fileDb.scanAndIndex({ trigger: 'manual' });
      const row = fileDb.db.prepare('SELECT id FROM indexed_chunks LIMIT 1').get() as { id: string };
      fileDb.db.prepare('UPDATE indexed_chunks SET chunk_text = ?, chunk_hash = ? WHERE id = ?')
        .run('thinkingSignature textSignature encrypted_content stale searchable', 'stale-sensitive-hash', row.id);
    } finally {
      fileDb.close();
    }

    const mod = await loadExtension();
    const mock = makeMockPi();
    mod.default(mock.api as never);

    const searchTool = mock.tools.find((tool) => tool.name === 'byomem_file_search')!;
    const result = await searchTool.execute('sensitive', { query: 'thinkingSignature encrypted_content', baseDir: projectDir, mode: 'fts', limit: 5 }) as { content: { text: string }[]; results?: unknown[] };
    const output = JSON.stringify(result);

    expect(result.results).toEqual([]);
    expect(output).not.toContain('thinkingSignature');
    expect(output).not.toContain('textSignature');
    expect(output).not.toContain('encrypted_content');
  });

});
