import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { openNativeStore } from '../src/store.js';

function makeTempRuntime(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-operations-mcp-'));
}

describe('Sprint 46 operations MCP server', () => {
  const transports: StdioClientTransport[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (transports.length) {
      await transports.pop()!.close();
    }
  });

  it('discovers mutation tools and performs end-to-end store, prune, scan, and refresh calls over stdio', async () => {
    const runtimeDir = makeTempRuntime();
    const scanTargetPath = join(runtimeDir, 'scan-target.txt');
    writeFileSync(scanTargetPath, 'scan target for Sprint 46\n', 'utf8');

    const operationsPath = join(process.cwd(), 'ts/packages/runtime/dist/mcp/operations.js');
    const transport = new StdioClientTransport({
      command: 'node',
      args: [operationsPath],
      cwd: process.cwd(),
      env: {
        ...process.env,
        BYOMEM_RUNTIME_BASE_DIR: runtimeDir,
      },
    });
    transports.push(transport);

    const client = new Client({ name: 'sprint-46-operations-mcp-test', version: '1.0.0' });
    await client.connect(transport);

    const toolList = await client.listTools();
    expect(toolList.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['status', 'search', 'store', 'prune', 'scan', 'refresh']));

    const statusResult = await client.callTool({ name: 'status' });
    const statusPayload = JSON.parse(statusResult.content[0].text ?? '{}') as { storeBaseDir?: string; activeProject?: Record<string, unknown> };
    expect(statusPayload).toMatchObject({
      storeBaseDir: runtimeDir,
      activeProject: expect.any(Object),
    });

    const storeResult = await client.callTool({
      name: 'store',
      arguments: {
        scope: 'project',
        identity: {
          namespace: 'Notes',
          leafName: 'Sprint 46 Mutation Target',
          parentContext: 'Root',
        },
        content: {
          text: 'Sprint 46 mutation target',
        },
        provenance: {
          source: 'vitest',
          adapter: 'mcp',
          origin: 'write',
        },
      },
    });
    const stored = JSON.parse(storeResult.content[0].text ?? '{}') as { tool?: string; record?: { id?: string; scope?: string; identity?: Record<string, unknown>; content?: Record<string, unknown> } };
    expect(stored.tool).toBe('store');
    expect(stored.record).toMatchObject({
      scope: 'project',
      identity: {
        namespace: 'notes',
        leafName: 'sprint-46-mutation-target',
        parentContext: 'root',
      },
      content: {
        text: 'Sprint 46 mutation target',
      },
      provenance: {
        source: 'vitest',
        adapter: 'mcp',
        origin: 'write',
      },
    });
    expect(stored.record?.id).toBe('project:notes:root:sprint-46-mutation-target');
    expect(existsSync(join(runtimeDir, 'native-store.json'))).toBe(false);
    expect(existsSync(join(runtimeDir, 'byomem-index.sqlite'))).toBe(true);
    const verifyStored = openNativeStore({ baseDir: runtimeDir, embeddingModel: 'fallback-deterministic-v1' });
    try {
      expect(verifyStored.read('project:notes:root:sprint-46-mutation-target')).toMatchObject({
        id: 'project:notes:root:sprint-46-mutation-target',
      });
    } finally {
      verifyStored.close();
    }

    const searchResult = await client.callTool({ name: 'search', arguments: { query: 'Sprint 46 mutation target', limit: 5 } });
    const searchPayload = JSON.parse(searchResult.content[0].text ?? '{}') as { results?: Array<Record<string, unknown>> };
    expect(searchPayload.results?.[0]).toMatchObject({
      id: 'project:notes:root:sprint-46-mutation-target',
      scope: 'project',
    });

    const scanResult = await client.callTool({ name: 'scan', arguments: { baseDir: runtimeDir } });
    const scanPayload = JSON.parse(scanResult.content[0].text ?? '{}') as {
      tool?: string;
      scanner?: { state?: string; baseDir?: string; progress?: { discoveredFiles?: number; indexedFiles?: number } };
    };
    expect(scanPayload.tool).toBe('scan');
    expect(scanPayload.scanner).toMatchObject({
      state: 'completed',
      baseDir: runtimeDir,
    });
    expect(scanPayload.scanner?.progress?.discoveredFiles ?? 0).toBeGreaterThanOrEqual(1);
    expect(scanPayload.scanner?.progress?.indexedFiles ?? 0).toBeGreaterThanOrEqual(1);

    const refreshResult = await client.callTool({ name: 'refresh', arguments: { baseDir: runtimeDir, limit: 10 } });
    const refreshPayload = JSON.parse(refreshResult.content[0].text ?? '{}') as {
      tool?: string;
      diagnostics?: { enabled?: boolean; state?: string; baseDir?: string; indexedChunks?: number; embeddedChunks?: number };
    };
    expect(refreshPayload.tool).toBe('refresh');
    expect(refreshPayload.diagnostics).toMatchObject({
      enabled: true,
      baseDir: runtimeDir,
    });
    expect(refreshPayload.diagnostics?.indexedChunks ?? 0).toBeGreaterThanOrEqual(1);
    expect(refreshPayload.diagnostics?.embeddedChunks ?? 0).toBeGreaterThanOrEqual(1);

    const pruneResult = await client.callTool({
      name: 'prune',
      arguments: {
        scope: 'project',
        identity: {
          namespace: 'Notes',
          leafName: 'Sprint 46 Mutation Target',
          parentContext: 'Root',
        },
      },
    });
    const pruned = JSON.parse(pruneResult.content[0].text ?? '{}') as { tool?: string; id?: string; deleted?: boolean; removed?: { id?: string } | null };
    expect(pruned.tool).toBe('prune');
    expect(pruned).toMatchObject({
      id: 'project:notes:root:sprint-46-mutation-target',
      deleted: true,
    });
    expect(pruned.removed).toMatchObject({ id: 'project:notes:root:sprint-46-mutation-target' });

    await client.close();

    const verifyPruned = openNativeStore({ baseDir: runtimeDir, embeddingModel: 'fallback-deterministic-v1' });
    try {
      expect(verifyPruned.list()).toEqual([]);
    } finally {
      verifyPruned.close();
    }
    expect(existsSync(join(runtimeDir, 'native-store.json'))).toBe(false);
    expect(existsSync(join(runtimeDir, 'byomem-file-search.sqlite'))).toBe(true);
  }, 15_000);
});
