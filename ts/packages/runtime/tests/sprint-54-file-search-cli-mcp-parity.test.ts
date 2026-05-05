import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { openFileSearchDb } from '../src/file-search-db.js';
import { registerOperationsTools } from '../src/mcp/operations-tools.js';

type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown> | unknown;
};

function tempDir(prefix = 'byomem-sprint-54-cli-mcp-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeMockPi() {
  const tools: RegisteredTool[] = [];
  return {
    tools,
    api: {
      on() {},
      registerCommand() {},
      registerTool(tool: RegisteredTool) {
        tools.push(tool);
      },
    },
  };
}

describe('Sprint 54 file-search CLI/MCP parity', () => {
  const dirs: string[] = [];
  const fileDbs: Array<ReturnType<typeof openFileSearchDb>> = [];
  const originalRuntimeBase = process.env.BYOMEM_RUNTIME_BASE_DIR;

  afterEach(() => {
    vi.restoreAllMocks();
    while (fileDbs.length) fileDbs.pop()?.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    if (originalRuntimeBase === undefined) delete process.env.BYOMEM_RUNTIME_BASE_DIR;
    else process.env.BYOMEM_RUNTIME_BASE_DIR = originalRuntimeBase;
  });

  it('routes search and status payloads through the same index contract across CLI, MCP, and Pi surfaces', async () => {
    const runtimeDir = tempDir('byomem-sprint-54-runtime-');
    const projectDir = tempDir('byomem-sprint-54-project-');
    dirs.push(runtimeDir, projectDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'alpha.ts'), 'export function alphaRoute() {\n  return 1;\n}\n', 'utf8');
    writeFileSync(join(projectDir, 'src', 'beta.ts'), 'export function betaRoute() {\n  return 2;\n}\n', 'utf8');
    writeFileSync(join(projectDir, 'notes.md'), 'alpha route notes\n', 'utf8');

    const runtimeDb = openFileSearchDb({
      baseDir: projectDir,
      dbBaseDir: runtimeDir,
      scanOnOpen: true,
      schedulerEnabled: false,
      semanticSearchEnabled: false,
      scannerIncludeTextFiles: true,
    });
    fileDbs.push(runtimeDb);

    const cliSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(['file-search', '--base-dir', projectDir, '--file-search-include-text-files', 'true', '--query', 'alpha route', '--mode', 'bm25', '--limit', '1', '--json']);
    const cliSearchPayload = JSON.parse(String(cliSpy.mock.calls.at(-1)?.[0] ?? '{}')) as {
      results?: Array<{ chunk?: { filePath?: string; startLine?: number; endLine?: number } }>;
    };
    expect(cliSearchPayload.results?.[0]?.chunk).toMatchObject({
      filePath: join(projectDir, 'src', 'alpha.ts'),
      startLine: 1,
      endLine: 3,
    });

    cliSpy.mockClear();
    await main(['file-search-status', '--base-dir', projectDir, '--file-search-include-text-files', 'true', '--json']);
    const cliStatusPayload = JSON.parse(String(cliSpy.mock.calls.at(-1)?.[0] ?? '{}')) as {
      index?: { index?: { indexedFiles?: number; chunkCount?: number; sourceType?: string } };
    };
    expect(cliStatusPayload.index).toMatchObject({
      index: {
        indexedFiles: 3,
        chunkCount: expect.any(Number),
        sourceType: 'path',
      },
    });

    const runtimeContext: any = {
      runtimeBaseDir: runtimeDir,
      nativeStore: {},
      embeddingConfig: { source: 'default' },
      fileSearchConfig: {
        source: 'default',
        indexStorageMode: 'disk',
        includeTextFiles: true,
        excludedExtensions: [],
        binaryDetectionEnabled: true,
      },
    };

    const tools: RegisteredTool[] = [];
    registerOperationsTools({
      registerTool(name: string, _meta: unknown, execute: RegisteredTool['execute']) {
        tools.push({
          name,
          execute: (_toolCallId: string, params: Record<string, unknown>) => execute(params),
        });
      },
    } as never, () => runtimeContext);

    const mcpSearch = tools.find((tool) => tool.name === 'byomem_file_search');
    expect(mcpSearch).toBeDefined();
    const mcpSearchRaw = await mcpSearch!.execute('1', { baseDir: projectDir, query: 'alpha route', mode: 'bm25', limit: 1 });
    const mcpSearchPayload = JSON.parse(String((mcpSearchRaw as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '{}')) as {
      results?: Array<{ chunk?: { filePath?: string; startLine?: number; endLine?: number } }>;
    };
    expect(mcpSearchPayload.results?.[0]?.chunk).toMatchObject({
      filePath: join(projectDir, 'src', 'alpha.ts'),
      startLine: 1,
      endLine: 3,
    });

    const mcpRelated = tools.find((tool) => tool.name === 'byomem_file_search_find_related');
    expect(mcpRelated).toBeDefined();
    const mcpRelatedRaw = await mcpRelated!.execute('2', { baseDir: projectDir, filePath: join(projectDir, 'src', 'alpha.ts'), line: 1, limit: 3 });
    const mcpRelatedPayload = JSON.parse(String((mcpRelatedRaw as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '{}')) as {
      results?: Array<{ chunk?: { filePath?: string } }>;
    };
    expect(Array.isArray(mcpRelatedPayload.results)).toBe(true);

    const piModule = await import('../src/pi-extension.js');
    const mockPi = makeMockPi();
    piModule.default(mockPi.api as never);

    const statusTool = mockPi.tools.find((tool) => tool.name === 'byomem_file_search_status');
    expect(statusTool).toBeDefined();
    const statusResult = await statusTool!.execute('3', { baseDir: projectDir }) as {
      scanner?: { baseDir?: string };
      index?: { index?: { indexedFiles?: number; chunkCount?: number; sourceType?: string } };
    };
    expect(statusResult.scanner?.baseDir).toBe(projectDir);
    expect(statusResult.index).toMatchObject({
      index: {
        indexedFiles: cliStatusPayload.index?.index?.indexedFiles,
        chunkCount: cliStatusPayload.index?.index?.chunkCount,
        sourceType: 'path',
      },
    });

    expect(mcpSearchPayload.results?.[0]?.chunk?.filePath).toBe(cliSearchPayload.results?.[0]?.chunk?.filePath);
  });
});
