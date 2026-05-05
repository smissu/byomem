import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { openFileSearchDb } from '../src/file-search-db.js';
import { buildFileSearchIndex } from '../src/file-search-index.js';
import { openNativeStore } from '../src/store.js';

function tempDir(prefix = 'byomem-sprint-54-status-'): string {
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

describe('Sprint 54 file-search status stats', () => {
  const dirs: string[] = [];
  const stores: Array<ReturnType<typeof openNativeStore>> = [];
  const fileDbs: Array<ReturnType<typeof openFileSearchDb>> = [];
  const originalRuntimeBase = process.env.BYOMEM_RUNTIME_BASE_DIR;

  afterEach(() => {
    vi.restoreAllMocks();
    while (stores.length) stores.pop()?.close();
    while (fileDbs.length) fileDbs.pop()?.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    if (originalRuntimeBase === undefined) delete process.env.BYOMEM_RUNTIME_BASE_DIR;
    else process.env.BYOMEM_RUNTIME_BASE_DIR = originalRuntimeBase;
  });

  it('exposes index, build, and embedding stats through the index object and status surfaces', async () => {
    const runtimeDir = tempDir('byomem-sprint-54-status-runtime-');
    const projectDir = tempDir('byomem-sprint-54-status-project-');
    dirs.push(runtimeDir, projectDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'alpha.ts'), 'export function alphaRoute() {\n  return 1;\n}\n', 'utf8');
    writeFileSync(join(projectDir, 'docs.md'), 'alpha route notes\n', 'utf8');

    const store = openNativeStore({
      baseDir: projectDir,
      fileSearchIncludeTextFiles: true,
      fileSearchScanOnOpen: true,
      fileSearchSchedulerEnabled: false,
      fileSearchSemanticEnabled: false,
    });
    stores.push(store);

    const runtimeDb = openFileSearchDb({
      baseDir: projectDir,
      dbBaseDir: runtimeDir,
      scanOnOpen: true,
      schedulerEnabled: false,
      semanticSearchEnabled: false,
      scannerIncludeTextFiles: true,
    });
    fileDbs.push(runtimeDb);

    const index = buildFileSearchIndex(store);
    const stats = index.stats();
    expect(stats).toMatchObject({
      index: {
        indexedFiles: 2,
        chunkCount: expect.any(Number),
        perLanguageCounts: expect.objectContaining({
          typescript: expect.any(Number),
          text: expect.any(Number),
        }),
      },
      build: {
        startedAt: expect.any(String),
        completedAt: expect.any(String),
        elapsedMs: expect.any(Number),
        projectFingerprint: expect.any(String),
        backendVersion: expect.any(String),
      },
      embedding: {
        enabled: false,
        model: expect.any(String),
        providerKey: expect.any(String),
        dimension: expect.any(Number),
        vectorByteSize: expect.any(Number),
        configuredDimension: expect.any(Number),
      },
    });

    const cliSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['file-search-status', '--base-dir', projectDir, '--file-search-include-text-files', 'true', '--json']);
    const cliPayload = JSON.parse(String(cliSpy.mock.calls.at(-1)?.[0] ?? '{}')) as {
      index?: { index?: { indexedFiles?: number; chunkCount?: number; sourceFingerprint?: string; sourceType?: string }; build?: { backendVersion?: string } };
    };
    expect(cliPayload.index).toMatchObject({
      index: {
        indexedFiles: stats.index.indexedFiles,
        chunkCount: stats.index.chunkCount,
        sourceFingerprint: stats.index.sourceFingerprint,
        sourceType: 'path',
      },
      build: {
        backendVersion: stats.build.backendVersion,
      },
    });

    const mockPi = makeMockPi();
    const piModule = await import('../src/pi-extension.js');
    piModule.default(mockPi.api as never);
    const statusTool = mockPi.tools.find((tool) => tool.name === 'byomem_file_search_status');
    expect(statusTool).toBeDefined();
    const statusPayload = await statusTool!.execute('1', { baseDir: projectDir }) as {
      index?: { index?: { indexedFiles?: number; chunkCount?: number; sourceFingerprint?: string; sourceType?: string } };
    };
    expect(statusPayload.index).toMatchObject({
      index: {
        indexedFiles: stats.index.indexedFiles,
        chunkCount: stats.index.chunkCount,
        sourceFingerprint: stats.index.sourceFingerprint,
        sourceType: 'path',
      },
    });
  });
});
