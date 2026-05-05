import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openFileSearchDb, resolveFileSearchProjectKey } from '../src/file-search-db.js';
import {
  disposeMockPi,
  makeMockPi,
  loadExtension,
  requireRegisteredTool,
  tempDir,
  type MockPi,
} from './helpers/pi-extension-test-utils.js';

describe('Sprint 38 file-search extension tool contract', () => {
  const dirs: string[] = [];
  const mockPis: MockPi[] = [];
  const originalFetch = globalThis.fetch;

  afterEach(async () => {
    while (mockPis.length) {
      await disposeMockPi(mockPis.pop()!);
    }
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
  });

  function trackedTemp(prefix: string): string {
    const dir = tempDir(prefix);
    dirs.push(dir);
    return dir;
  }

  function trackedConfig(prefix: string, content = ''): string {
    const configDir = trackedTemp(prefix);
    const configPath = join(configDir, 'config.yaml');
    writeFileSync(configPath, content, 'utf8');
    vi.stubEnv('BYOMEM_CONFIG_PATH', configPath);
    return configPath;
  }

  function trackedMockPi(): MockPi {
    const mock = makeMockPi();
    mockPis.push(mock);
    return mock;
  }

  it('registers the direct file-search tools with strict schemas', async () => {
    const mod = await loadExtension();
    const mock = trackedMockPi();
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

    expect(requireRegisteredTool(mock, 'byomem_file_search').parameters).toEqual({
      type: 'object',
      properties: {
        query: { type: 'string' },
        mode: { type: 'string', enum: ['bm25', 'semantic', 'hybrid'] },
        limit: { type: 'integer', minimum: 1 },
        baseDir: { type: 'string' },
      },
      required: ['query'],
      additionalProperties: false,
    });
    expect(requireRegisteredTool(mock, 'byomem_file_search_find_related').parameters).toEqual({
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
    expect(requireRegisteredTool(mock, 'byomem_file_search_status').parameters).toEqual({
      type: 'object',
      properties: { baseDir: { type: 'string' }, jobId: { type: 'string' } },
      additionalProperties: false,
    });
    expect(requireRegisteredTool(mock, 'byomem_file_search_scan').parameters).toEqual({
      type: 'object',
      properties: { baseDir: { type: 'string' }, async: { type: 'boolean' }, wait: { type: 'boolean' } },
      additionalProperties: false,
    });
    expect(requireRegisteredTool(mock, 'byomem_file_search_project_register').parameters).toEqual({
      type: 'object',
      properties: { baseDir: { type: 'string' } },
      required: ['baseDir'],
      additionalProperties: false,
    });
    expect(requireRegisteredTool(mock, 'byomem_file_search_project_list').parameters).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
    expect(requireRegisteredTool(mock, 'byomem_file_search_project_unregister').parameters).toEqual({
      type: 'object',
      properties: { baseDir: { type: 'string' } },
      required: ['baseDir'],
      additionalProperties: false,
    });
  });

  it('rejects blank baseDir and does not fall back to runtime storage', async () => {
    const runtimeDir = trackedTemp('byomem-s38-runtime-');
    const projectDir = trackedTemp('byomem-s38-project-');
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', runtimeDir);
    writeFileSync(join(projectDir, 'needle.txt'), 'needle body\n', 'utf8');
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    const mod = await loadExtension();
    const mock = trackedMockPi();
    mod.default(mock.api as never);

    const searchTool = requireRegisteredTool(mock, 'byomem_file_search');
    await expect(searchTool.execute('1', { query: 'needle', baseDir: '   ' })).rejects.toThrow(/baseDir/i);
    cwdSpy.mockRestore();
  });

  it('validates query, mode, and positive integer limit for byomem_file_search', async () => {
    const projectDir = trackedTemp('byomem-s38-validate-');
    vi.spyOn(process, 'cwd').mockReturnValue(projectDir);

    const mod = await loadExtension();
    const mock = trackedMockPi();
    mod.default(mock.api as never);

    const searchTool = requireRegisteredTool(mock, 'byomem_file_search');
    await expect(searchTool.execute('1', {})).rejects.toThrow(/query/i);
    await expect(searchTool.execute('2', { query: '   ' })).rejects.toThrow(/query/i);
    await expect(searchTool.execute('3', { query: 'needle', mode: 'lexical' })).rejects.toThrow(/mode/i);
    await expect(searchTool.execute('4', { query: 'needle', limit: 0 })).rejects.toThrow(/limit/i);
    await expect(searchTool.execute('5', { query: 'needle', limit: 1.5 })).rejects.toThrow(/limit/i);
    await expect(searchTool.execute('6', { query: 'needle', limit: '2' })).rejects.toThrow(/limit/i);
  });

  it('keeps same-basename projects isolated and does not implicitly scan or refresh semantic embeddings on file search', async () => {
    const runtimeDir = trackedTemp('byomem-s38-runtime-');
    const projectA = trackedTemp('byomem-s38-a-');
    const projectB = trackedTemp('byomem-s38-b-');
    trackedConfig('byomem-s38-same-basename-config-');
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', runtimeDir);
    writeFileSync(join(projectA, 'same.txt'), 'alpha same basename body\n', 'utf8');
    writeFileSync(join(projectB, 'same.txt'), 'beta same basename body\n', 'utf8');

    const seedProject = (baseDir: string): void => {
      const fileDb = openFileSearchDb({
        baseDir,
        dbBaseDir: runtimeDir,
        scanOnOpen: false,
        schedulerEnabled: false,
        semanticSearchEnabled: false,
        scannerIncludeTextFiles: true,
      });
      try {
        fileDb.scanAndIndex();
      } finally {
        fileDb.close();
      }
    };

    seedProject(projectA);
    seedProject(projectB);
    const runtimeDb = join(runtimeDir, 'byomem-file-search.sqlite');
    const runtimeDbMtime = statSync(runtimeDb).mtimeMs;

    const mod = await loadExtension();
    const mock = trackedMockPi();
    mod.default(mock.api as never);

    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ embedding: [1, 0, 0] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const searchTool = requireRegisteredTool(mock, 'byomem_file_search');
    const result = await searchTool.execute('1', { query: 'same', baseDir: projectA, mode: 'hybrid', limit: 5 }) as {
      results?: Array<{ chunk?: { filePath?: string } }>;
      semantic?: { projectKey?: string };
    };

    expect(result).toMatchObject({ results: expect.any(Array) });
    expect((result.results ?? []).every((hit) => hit.chunk?.filePath?.startsWith(projectA))).toBe(true);
    expect((result.results ?? []).some((hit) => hit.chunk?.filePath?.startsWith(projectB))).toBe(false);
    expect((result.results ?? []).length).toBeGreaterThan(0);
    expect(result.semantic?.projectKey).toBe(resolveFileSearchProjectKey(projectA));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(statSync(runtimeDb).mtimeMs).toBe(runtimeDbMtime);
    expect(existsSync(join(projectA, 'byomem-index.sqlite'))).toBe(false);
    expect(existsSync(join(projectB, 'byomem-index.sqlite'))).toBe(false);
  });
});
