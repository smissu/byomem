import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { createOperationsMcpServer } from '../src/mcp/operations-server.js';
import { openFileSearchDb } from '../src/file-search-db.js';
import { openNativeStore } from '../src/store.js';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function seedNativeStoreConflict(baseDir: string): Promise<void> {
  const store = openNativeStore({ baseDir, embeddingModel: 'fallback-deterministic-v1' });
  try {
    await store.write({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'conflict-seed', parentContext: 'root' },
      content: { text: 'conflict seed' },
      provenance: { source: 'test' },
    });
    const seeded = store.list()[0];
    if (!seeded) throw new Error('Failed to seed native store conflict');
    writeFileSync(join(baseDir, 'native-store.json'), JSON.stringify({
      version: 1,
      records: [{
        ...seeded,
        content: { ...seeded.content, text: `${seeded.content.text ?? 'seed'} mismatch` },
      }],
    }, null, 2), 'utf8');
  } finally {
    store.close();
  }
}

function seedFileSearchIndex(projectDir: string, runtimeDir: string): void {
  writeFileSync(join(projectDir, 'src-file-search-target.ts'), 'export const alphaRoute = "alpha route";\n', 'utf8');
  const fileDb = openFileSearchDb({
    baseDir: projectDir,
    dbBaseDir: runtimeDir,
    scanOnOpen: true,
    schedulerEnabled: false,
    semanticSearchEnabled: false,
    scannerIncludeTextFiles: true,
  });
  try {
    expect(fileDb.getScannerStatus().state).toBe('completed');
  } finally {
    fileDb.close();
  }
}

describe('Sprint 62 file-search conflict decoupling', () => {
  const dirs: string[] = [];
  const originalRuntimeBase = process.env.BYOMEM_RUNTIME_BASE_DIR;

  afterEach(() => {
    vi.restoreAllMocks();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    if (originalRuntimeBase === undefined) delete process.env.BYOMEM_RUNTIME_BASE_DIR;
    else process.env.BYOMEM_RUNTIME_BASE_DIR = originalRuntimeBase;
    process.exitCode = undefined;
  });

  it('keeps file-search status/search/project-list surfaces working when the native store snapshot conflicts with SQLite', async () => {
    const runtimeDir = tempDir('byomem-s62-runtime-');
    const projectDir = tempDir('byomem-s62-project-');
    dirs.push(runtimeDir, projectDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;

    seedFileSearchIndex(projectDir, runtimeDir);
    await seedNativeStoreConflict(projectDir);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await main(['file-search-status', '--base-dir', projectDir, '--file-search-include-text-files', 'true', '--json']);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      status: expect.objectContaining({
        state: expect.any(String),
        progress: expect.objectContaining({ indexedFiles: expect.any(Number) }),
      }),
      index: expect.objectContaining({
        index: expect.objectContaining({
          indexedFiles: expect.any(Number),
        }),
      }),
    });

    logSpy.mockClear();
    await main(['file-search', '--base-dir', projectDir, '--file-search-include-text-files', 'true', '--query', 'alpha route', '--mode', 'bm25', '--limit', '1', '--json']);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      results: [
        expect.objectContaining({
          chunk: expect.objectContaining({
            filePath: join(projectDir, 'src-file-search-target.ts'),
          }),
        }),
      ],
      index: expect.objectContaining({
        index: expect.objectContaining({
          indexedFiles: expect.any(Number),
        }),
      }),
    });

    logSpy.mockClear();
    await main(['file-search-project-list', '--json']);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      projects: expect.any(Array),
    });

    await main(['search', '--base-dir', projectDir, '--query', 'alpha route', '--mode', 'bm25']);
    expect(JSON.parse(String(errSpy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      error: expect.stringContaining('Native store migration conflict'),
      command: 'search',
    });

    process.exitCode = undefined;
    await main(['store', '--base-dir', projectDir, '--embedding-base-url', 'http://localhost:11434/v1', '--embedding-model', 'nomic-embed-text', '--input', JSON.stringify({
      scope: 'project',
      identity: { namespace: 'byomem', leafName: 'conflict-store', parentContext: 'root' },
      content: { text: 'conflict store' },
      provenance: { source: 'test' },
    })]);
    expect(JSON.parse(String(errSpy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      error: expect.stringContaining('Native store migration conflict'),
      command: 'store',
    });

    process.exitCode = undefined;
    await main(['prune', '--base-dir', projectDir, '--id', 'project:byomem:root:conflict-seed']);
    expect(JSON.parse(String(errSpy.mock.calls.at(-1)?.[0] ?? '{}'))).toMatchObject({
      error: expect.stringContaining('Native store migration conflict'),
      command: 'prune',
    });

    expect(process.exitCode).toBe(1);
  });

  it('creates the operations MCP server without eagerly opening the native store', async () => {
    const runtimeDir = tempDir('byomem-s62-mcp-runtime-');
    dirs.push(runtimeDir);
    process.env.BYOMEM_RUNTIME_BASE_DIR = runtimeDir;
    await seedNativeStoreConflict(runtimeDir);

    expect(() => createOperationsMcpServer()).not.toThrow();
    expect(existsSync(join(runtimeDir, 'native-store.json'))).toBe(true);
  });
});
