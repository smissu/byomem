import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { openFileSearchDb, resolveFileSearchProjectKey } from '../src/file-search-db.js';

function tempDir(prefix = 'byomem-s56-runtime-surfaces-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeMockPi() {
  const tools: Array<{ name: string; execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown> | unknown }> = [];
  return {
    tools,
    api: {
      on() {},
      registerCommand() {},
      registerTool(tool: { name: string; execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown> | unknown }) {
        tools.push(tool);
      },
    },
  };
}

async function loadExtension() {
  vi.resetModules();
  return import('../src/pi-extension.ts');
}

function parseJsonCall(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  return JSON.parse(String(spy.mock.calls.at(-1)?.[0] ?? '{}')) as Record<string, unknown>;
}

function indexedFileCount(projectDir: string, runtimeDir: string): number {
  const fileDb = openFileSearchDb({
    baseDir: projectDir,
    dbBaseDir: runtimeDir,
    scanOnOpen: false,
    schedulerEnabled: false,
    semanticSearchEnabled: false,
    scannerIncludeTextFiles: true,
  });
  try {
    const row = fileDb.db.prepare('SELECT COUNT(*) AS count FROM indexed_files WHERE project_key = ?').get(resolveFileSearchProjectKey(projectDir)) as { count: number };
    return row.count;
  } finally {
    fileDb.close();
  }
}

function expectHotIndexDiagnostics(payload: Record<string, unknown>, label: string): Record<string, unknown> {
  expect(payload, `${label} payload`).toHaveProperty('index');
  const index = payload.index as Record<string, unknown>;
  expect(index, `${label} index`).toEqual(expect.objectContaining({
    build: expect.objectContaining({
      startedAt: expect.any(String),
      completedAt: expect.any(String),
      elapsedMs: expect.any(Number),
    }),
    hotIndex: expect.objectContaining({
      state: expect.stringMatching(/^(cold|hydrating|ready|stale|building|failed)$/),
      source: expect.stringMatching(/^(none|sqlite|memory)$/),
      chunkCount: expect.any(Number),
      vectorCount: expect.any(Number),
      hydrateCount: expect.any(Number),
      buildCount: expect.any(Number),
      revision: expect.any(Number),
    }),
  }));
  return index.hotIndex as Record<string, unknown>;
}

describe('Sprint 56 hot-index runtime surfaces', () => {
  const dirs: string[] = [];
  const originalRuntimeBase = process.env.BYOMEM_RUNTIME_BASE_DIR;
  const originalIncludeTextFiles = process.env.BYOMEM_FILE_SEARCH_INCLUDE_TEXT_FILES;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    if (originalRuntimeBase === undefined) delete process.env.BYOMEM_RUNTIME_BASE_DIR;
    else process.env.BYOMEM_RUNTIME_BASE_DIR = originalRuntimeBase;
    if (originalIncludeTextFiles === undefined) delete process.env.BYOMEM_FILE_SEARCH_INCLUDE_TEXT_FILES;
    else process.env.BYOMEM_FILE_SEARCH_INCLUDE_TEXT_FILES = originalIncludeTextFiles;
    process.exitCode = undefined;
  });

  it('exposes hot-index diagnostics in CLI scan/status/search while keeping status and search side-effect free', async () => {
    const runtimeDir = tempDir('byomem-s56-cli-runtime-');
    const projectDir = tempDir('byomem-s56-cli-project-');
    dirs.push(runtimeDir, projectDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    writeFileSync(join(projectDir, 'needle.txt'), 'needle in the indexed haystack\n', 'utf8');

    const statusSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['file-search-status', '--base-dir', projectDir, '--json']);
    const statusPayload = parseJsonCall(statusSpy);
    expectHotIndexDiagnostics(statusPayload, 'CLI status');
    expect(indexedFileCount(projectDir, runtimeDir)).toBe(0);
    statusSpy.mockRestore();

    const searchSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['file-search', '--base-dir', projectDir, '--mode', 'bm25', '--query', 'needle', '--json']);
    const searchPayload = parseJsonCall(searchSpy);
    expectHotIndexDiagnostics(searchPayload, 'CLI search');
    expect(searchPayload.results).toEqual([]);
    expect(indexedFileCount(projectDir, runtimeDir)).toBe(0);
    searchSpy.mockRestore();

    const scanSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['file-search-scan', '--base-dir', projectDir, '--file-search-include-text-files', 'true', '--json']);
    const scanPayload = parseJsonCall(scanSpy);
    const scanHotIndex = expectHotIndexDiagnostics(scanPayload, 'CLI scan');
    expect(scanPayload.scanner).toMatchObject({
      state: 'completed',
      baseDir: projectDir,
      database: expect.objectContaining({ indexedFiles: 1 }),
    });
    expect(indexedFileCount(projectDir, runtimeDir)).toBe(1);
    expect(scanHotIndex).toEqual(expect.objectContaining({
      state: expect.any(String),
      source: expect.any(String),
      revision: expect.any(Number),
    }));
  });

  it('reuses hot-index diagnostics across the long-lived Pi direct scan/search surface without implicit status scans', async () => {
    const runtimeDir = tempDir('byomem-s56-pi-runtime-');
    const projectDir = tempDir('byomem-s56-pi-project-');
    dirs.push(runtimeDir, projectDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    process.env.BYOMEM_FILE_SEARCH_INCLUDE_TEXT_FILES = 'true';
    writeFileSync(join(projectDir, 'needle.txt'), 'needle in the indexed haystack\n', 'utf8');

    const mod = await loadExtension();
    const mock = makeMockPi();
    mod.default(mock.api as never);

    const statusTool = mock.tools.find((tool) => tool.name === 'byomem_file_search_status');
    const scanTool = mock.tools.find((tool) => tool.name === 'byomem_file_search_scan');
    const searchTool = mock.tools.find((tool) => tool.name === 'byomem_file_search');
    expect(statusTool).toBeDefined();
    expect(scanTool).toBeDefined();
    expect(searchTool).toBeDefined();

    const status = await statusTool!.execute('1', { baseDir: projectDir }) as { index?: Record<string, unknown> };
    expectHotIndexDiagnostics(status, 'Pi status');
    expect(indexedFileCount(projectDir, runtimeDir)).toBe(0);

    const scan = await scanTool!.execute('2', { baseDir: projectDir }) as { index?: Record<string, unknown>; scanner?: { database?: { indexedFiles?: number } } };
    const scanHotIndex = expectHotIndexDiagnostics(scan, 'Pi scan');
    expect(scan.scanner).toMatchObject({ database: expect.objectContaining({ indexedFiles: 1 }) });
    expect(indexedFileCount(projectDir, runtimeDir)).toBe(1);

    const search = await searchTool!.execute('3', { baseDir: projectDir, mode: 'bm25', query: 'needle', limit: 5 }) as { index?: Record<string, unknown>; results?: unknown[] };
    const searchHotIndex = expectHotIndexDiagnostics(search, 'Pi search');
    expect(search.results).not.toEqual([]);
    expect(searchHotIndex).toEqual(expect.objectContaining({
      state: scanHotIndex.state,
      source: scanHotIndex.source,
      revision: scanHotIndex.revision,
      buildCount: scanHotIndex.buildCount,
    }));
  }, 15_000);
});
