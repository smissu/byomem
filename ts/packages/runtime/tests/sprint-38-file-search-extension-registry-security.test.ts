import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openFileSearchDb } from '../src/file-search-db.js';
import { disposeMockPi, loadExtension, makeMockPi, parseFirstContentJson, tempDir, type MockPi } from './helpers/pi-extension-test-utils.js';

describe('Sprint 38 file-search extension registry and sensitive output security', () => {
  const dirs: string[] = [];
  const mocks: MockPi[] = [];
  const originalFetch = globalThis.fetch;

  afterEach(async () => {
    while (mocks.length) {
      await disposeMockPi(mocks.pop()!);
    }
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
  });

  function stubOfflineRuntime(runtimeDir: string): void {
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', runtimeDir);
    vi.stubEnv('BYOMEM_EMBEDDING_BASE_URL', 'http://127.0.0.1:9');
    vi.stubEnv('BYOMEM_EMBEDDING_MODEL', 'pi-test-model');
    vi.stubEnv('BYOMEM_EMBEDDING_DIMENSION', '3');
  }

  it('does not create a registry row when file-search status is invoked for a previously unseen temp baseDir', async () => {
    const projectDir = tempDir('byomem-s38-unseen-status-');
    const runtimeDir = tempDir('byomem-s38-unseen-runtime-');
    dirs.push(projectDir, runtimeDir);
    writeFileSync(join(projectDir, 'unseen.txt'), 'unseen status body\n', 'utf8');
    stubOfflineRuntime(runtimeDir);

    const mod = await loadExtension();
    const mock = makeMockPi();
    mocks.push(mock);
    mod.default(mock.api as never);

    const statusTool = mock.tools.find((tool) => tool.name === 'byomem_file_search_status')!;
    await statusTool.execute('1', { baseDir: projectDir });

    const listTool = mock.tools.find((tool) => tool.name === 'byomem_file_search_project_list')!;
    const listResult = await listTool.execute('2', {}) as { content: Array<{ text: string }>; details?: { projects?: Array<{ base_dir?: string }> } };
    const projects = listResult.details?.projects ?? parseFirstContentJson<{ projects?: Array<{ base_dir?: string }> }>(listResult)?.projects ?? [];

    expect(projects).toEqual([]);
    expect(projects).not.toEqual(expect.arrayContaining([expect.objectContaining({ base_dir: projectDir })]));
  });

  it('register/list/unregister tools require explicit baseDir on register/unregister and do not enable registry from memory tools', async () => {
    const projectDir = tempDir('byomem-s38-registry-');
    const runtimeDir = tempDir('byomem-s38-registry-runtime-');
    dirs.push(projectDir, runtimeDir);
    writeFileSync(join(projectDir, 'registry.txt'), 'registry body\n', 'utf8');
    stubOfflineRuntime(runtimeDir);

    const mod = await loadExtension();
    const mock = makeMockPi();
    mocks.push(mock);
    mod.default(mock.api as never);

    const registerTool = mock.tools.find((tool) => tool.name === 'byomem_file_search_project_register')!;
    const listTool = mock.tools.find((tool) => tool.name === 'byomem_file_search_project_list')!;
    const unregisterTool = mock.tools.find((tool) => tool.name === 'byomem_file_search_project_unregister')!;
    const storeTool = mock.tools.find((tool) => tool.name === 'byomem_store')!;

    await expect(registerTool.execute('1', {})).rejects.toThrow(/baseDir/i);
    await expect(registerTool.execute('2', { baseDir: '   ' })).rejects.toThrow(/baseDir/i);
    await expect(unregisterTool.execute('3', {})).rejects.toThrow(/baseDir/i);
    await expect(unregisterTool.execute('4', { baseDir: '   ' })).rejects.toThrow(/baseDir/i);

    const listResult = await listTool.execute('5', {}) as { content: Array<{ text: string }>; details?: { projects?: unknown[] } };
    const list = listResult.details ?? parseFirstContentJson<{ projects?: unknown[] }>(listResult) ?? {};
    expect(list).toMatchObject({ projects: expect.any(Array) });

    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ embedding: [1, 0, 0] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

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
    stubOfflineRuntime(runtimeDir);

    const fileDb = openFileSearchDb({
      baseDir: projectDir,
      dbBaseDir: runtimeDir,
      scanOnOpen: false,
      schedulerEnabled: false,
      semanticSearchEnabled: false,
      scannerIncludeTextFiles: true,
    });
    try {
      fileDb.scanAndIndex({ trigger: 'manual' });
      const row = fileDb.db.prepare('SELECT id FROM indexed_chunks LIMIT 1').get() as { id: string };
      fileDb.db.prepare('UPDATE indexed_chunks SET chunk_text = ?, search_text = ?, chunk_hash = ? WHERE id = ?')
        .run(
          '{"thinkingSignature":"stale-support","encrypted_content":"opaque"}',
          'stale searchable {"thinkingSignature":"stale-support","encrypted_content":"opaque"}',
          'stale-sensitive-hash',
          row.id,
        );
    } finally {
      fileDb.close();
    }

    const mod = await loadExtension();
    const mock = makeMockPi();
    mocks.push(mock);
    mod.default(mock.api as never);

    const searchTool = mock.tools.find((tool) => tool.name === 'byomem_file_search')!;
    const result = await searchTool.execute('sensitive', { query: 'stale searchable', baseDir: projectDir, mode: 'bm25', limit: 5 }) as { content: Array<{ text: string }>; results?: unknown[] };
    const output = JSON.stringify(result);

    expect(result.results).toEqual([]);
    expect(output).not.toContain('thinkingSignature');
    expect(output).not.toContain('textSignature');
    expect(output).not.toContain('encrypted_content');
  });
});
