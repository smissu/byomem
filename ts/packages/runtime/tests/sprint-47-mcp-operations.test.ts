import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function startMockEmbeddingServer(): Promise<{ server: Server; url: string; getRequestCount: () => number }> {
  let requestCount = 0;
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/embeddings') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not-found' }));
      return;
    }
    requestCount += 1;
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      void chunks;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ embedding: [1, 0, 0] }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to start mock embedding server');
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    getRequestCount: () => requestCount,
  };
}

describe('Sprint 47 operations MCP server hardening', () => {
  const transports: StdioClientTransport[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (transports.length) {
      await transports.pop()!.close();
    }
    while (servers.length) {
      await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
    }
  });

  it('exposes file-search registry and polling controls with active-project defaults and stable JSON DTOs over stdio', async () => {
    const runtimeDir = makeTempDir('byomem-operations-s47-runtime-');
    const projectDir = makeTempDir('byomem-operations-s47-project-');
    const configPath = join(runtimeDir, 'byomem-config.yaml');
    mkdirSync(join(projectDir, 'notes'), { recursive: true });
    writeFileSync(join(projectDir, 'notes', 'file-search-target.txt'), 'byomem file-search tool needle unique target text\n', 'utf8');
    writeFileSync(join(projectDir, 'notes', 'related-target.txt'), 'byomem file-search tool needle related companion text\n', 'utf8');
    writeFileSync(configPath, 'embeddings:\n  dimension: 768\n', 'utf8');
    const operationsPath = join(process.cwd(), 'ts/packages/runtime/dist/mcp/operations.js');

    const transport = new StdioClientTransport({
      command: 'node',
      args: [operationsPath],
      cwd: projectDir,
      env: {
        ...process.env,
        BYOMEM_RUNTIME_BASE_DIR: runtimeDir,
        BYOMEM_CONFIG_PATH: configPath,
      },
    });
    transports.push(transport);

    const client = new Client({ name: 'sprint-47-operations-mcp-test', version: '1.0.0' });
    await client.connect(transport);

    const toolList = await client.listTools();
    expect(toolList.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'status',
      'search',
      'store',
      'prune',
      'scan',
      'refresh',
      'byomem_file_search',
      'byomem_file_search_find_related',
      'byomem_file_search_project_register',
      'byomem_file_search_project_list',
      'byomem_file_search_project_unregister',
      'byomem_file_search_polling_status',
      'byomem_file_search_polling_enable',
      'byomem_file_search_polling_disable',
    ]));

    const initialList = await client.callTool({ name: 'byomem_file_search_project_list', arguments: {} });
    expect(JSON.parse(initialList.content[0].text ?? '{}')).toMatchObject({ projects: [] });

    const initialPolling = await client.callTool({ name: 'byomem_file_search_polling_status', arguments: {} });
    const initialPollingPayload = JSON.parse(initialPolling.content[0].text ?? '{}') as {
      polling?: Record<string, unknown>;
      status?: Record<string, unknown>;
    };
    expect(initialPollingPayload).toMatchObject({
      polling: {
        base_dir: expect.stringMatching(/byomem-operations-s47-project-/),
        polling_enabled: false,
        polling_disabled_reason: 'default-off',
      },
    });
    expect(initialPollingPayload.status).toMatchObject(initialPollingPayload.polling ?? {});

    const canonicalProjectDir = String(initialPollingPayload.polling?.base_dir ?? projectDir);

    const scanResult = await client.callTool({
      name: 'scan',
      arguments: { baseDir: canonicalProjectDir },
    });
    const scanPayload = JSON.parse(scanResult.content[0].text ?? '{}') as {
      scanner?: { baseDir?: string };
      status?: { baseDir?: string };
    };
    expect(scanPayload.scanner).toMatchObject({ baseDir: canonicalProjectDir });
    expect(scanPayload.status).toMatchObject({ baseDir: canonicalProjectDir });

    const fileSearchResult = await client.callTool({
      name: 'byomem_file_search',
      arguments: { query: 'needle', baseDir: canonicalProjectDir, limit: 5 },
    });
    const fileSearchPayload = JSON.parse(fileSearchResult.content[0].text ?? '{}') as {
      results?: Array<{ chunk?: { filePath?: string; content?: string } }>;
      semantic?: Record<string, unknown>;
    };
    expect(fileSearchPayload.results?.[0]).toMatchObject({
      chunk: {
        filePath: join(canonicalProjectDir, 'notes', 'file-search-target.txt'),
      },
    });
    expect(fileSearchPayload.results?.[0]?.chunk?.content).toContain('needle');

    const relatedResult = await client.callTool({
      name: 'byomem_file_search_find_related',
      arguments: { baseDir: canonicalProjectDir, filePath: join(canonicalProjectDir, 'notes', 'file-search-target.txt'), line: 1, limit: 3 },
    });
    const relatedPayload = JSON.parse(relatedResult.content[0].text ?? '{}') as {
      results?: Array<{ chunk?: { filePath?: string; content?: string } }>;
    };
    expect(Array.isArray(relatedPayload.results)).toBe(true);

    const registerResult = await client.callTool({
      name: 'byomem_file_search_project_register',
      arguments: { baseDir: canonicalProjectDir },
    });
    const registeredPayload = JSON.parse(registerResult.content[0].text ?? '{}') as {
      project?: { base_dir?: string; project_key?: string; state?: string; source?: string; polling_enabled?: boolean; polling_disabled_reason?: string | null; registered_at?: string };
    };
    expect(registeredPayload).toMatchObject({
      project: {
        base_dir: canonicalProjectDir,
        state: 'enabled',
        source: 'manual-register',
        polling_enabled: false,
        polling_disabled_reason: 'default-off',
        registered_at: expect.any(String),
      },
    });
    expect(registeredPayload.project?.project_key).toMatch(/^project:/);

    const listAfterRegister = await client.callTool({ name: 'byomem_file_search_project_list', arguments: {} });
    expect(JSON.parse(listAfterRegister.content[0].text ?? '{}')).toMatchObject({
      projects: [expect.objectContaining({
        base_dir: canonicalProjectDir,
        state: 'enabled',
        source: 'manual-register',
        polling_enabled: false,
      })],
    });

    const enableResult = await client.callTool({
      name: 'byomem_file_search_polling_enable',
      arguments: {
        pollIntervalSeconds: 5,
        idleDisableAfterPolls: 2,
      },
    });
    const enabledPayload = JSON.parse(enableResult.content[0].text ?? '{}') as {
      polling?: Record<string, unknown>;
      status?: Record<string, unknown>;
    };
    expect(enabledPayload.polling).toMatchObject({
      base_dir: canonicalProjectDir,
      polling_enabled: true,
      poll_interval_seconds: 5,
      idle_disable_after_polls: 2,
      polling_disabled_reason: null,
    });
    expect(enabledPayload.status).toMatchObject(enabledPayload.polling ?? {});

    const statusAfterEnable = await client.callTool({ name: 'byomem_file_search_polling_status', arguments: {} });
    const statusAfterEnablePayload = JSON.parse(statusAfterEnable.content[0].text ?? '{}') as {
      polling?: Record<string, unknown>;
      status?: Record<string, unknown>;
    };
    expect(statusAfterEnablePayload).toMatchObject({
      polling: {
        base_dir: canonicalProjectDir,
        polling_enabled: true,
        poll_interval_seconds: 5,
        idle_disable_after_polls: 2,
        polling_disabled_reason: null,
      },
    });
    expect(statusAfterEnablePayload.status).toMatchObject(statusAfterEnablePayload.polling ?? {});

    const disableResult = await client.callTool({
      name: 'byomem_file_search_polling_disable',
      arguments: {
        reason: 'session-ended',
      },
    });
    const disabledPayload = JSON.parse(disableResult.content[0].text ?? '{}') as {
      polling?: Record<string, unknown>;
      status?: Record<string, unknown>;
    };
    expect(disabledPayload.polling).toMatchObject({
      base_dir: canonicalProjectDir,
      polling_enabled: false,
      polling_disabled_reason: 'session-ended',
      next_poll_at: null,
    });
    expect(disabledPayload.status).toMatchObject(disabledPayload.polling ?? {});

    const unregisterResult = await client.callTool({
      name: 'byomem_file_search_project_unregister',
      arguments: { baseDir: canonicalProjectDir },
    });
    const unregisteredPayload = JSON.parse(unregisterResult.content[0].text ?? '{}') as {
      project?: Record<string, unknown>;
    };
    expect(unregisteredPayload.project).toMatchObject({
      base_dir: canonicalProjectDir,
      state: 'disabled',
      source: 'manual-unregister',
      polling_enabled: false,
      polling_disabled_reason: 'project-disabled',
    });

    const finalList = await client.callTool({ name: 'byomem_file_search_project_list', arguments: {} });
    expect(JSON.parse(finalList.content[0].text ?? '{}')).toMatchObject({
      projects: [expect.objectContaining({
        base_dir: canonicalProjectDir,
        state: 'disabled',
        source: 'manual-unregister',
        polling_enabled: false,
        polling_disabled_reason: 'project-disabled',
      })],
    });

    await client.close();

    expect(existsSync(join(runtimeDir, 'byomem-file-search.sqlite'))).toBe(true);
    expect(existsSync(join(projectDir, 'byomem-file-search.sqlite'))).toBe(false);
  });

  it('forwards embedding config through the MCP direct file-search path', async () => {
    const runtimeDir = makeTempDir('byomem-operations-s47-runtime-embed-');
    const projectDir = makeTempDir('byomem-operations-s47-project-embed-');
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src', 'alpha.ts'), 'export const alpha = 1;\nexport const beta = 2;\n', 'utf8');
    writeFileSync(join(projectDir, 'src', 'beta.ts'), 'export const gamma = 3;\n', 'utf8');

    const mockEmbedding = await startMockEmbeddingServer();
    servers.push(mockEmbedding.server);

    const operationsPath = join(process.cwd(), 'ts/packages/runtime/dist/mcp/operations.js');
    const transport = new StdioClientTransport({
      command: 'node',
      args: [operationsPath],
      cwd: projectDir,
      env: {
        ...process.env,
        BYOMEM_RUNTIME_BASE_DIR: runtimeDir,
        BYOMEM_EMBEDDING_BASE_URL: mockEmbedding.url,
        BYOMEM_EMBEDDING_MODEL: 'semble-mock-code-model',
        BYOMEM_EMBEDDING_DIMENSION: '3',
      },
    });
    transports.push(transport);

    const client = new Client({ name: 'sprint-47-operations-mcp-embedding-test', version: '1.0.0' });
    await client.connect(transport);

    const status = await client.callTool({ name: 'status', arguments: {} });
    const statusPayload = JSON.parse(status.content[0].text ?? '{}') as {
      embeddingConfigSource?: string;
      embeddingModel?: string;
      embeddingBaseUrl?: string;
    };
    expect(statusPayload).toMatchObject({
      embeddingConfigSource: 'env',
      embeddingModel: 'semble-mock-code-model',
      embeddingBaseUrl: mockEmbedding.url,
    });

    const scanResult = await client.callTool({ name: 'scan', arguments: { baseDir: projectDir } });
    const scanPayload = JSON.parse(scanResult.content[0].text ?? '{}') as {
      scanner?: { embeddings?: { model?: string; embeddedChunks?: number; actualDimensions?: Array<{ dimension: number }> } };
      status?: { embeddings?: { model?: string; embeddedChunks?: number; actualDimensions?: Array<{ dimension: number }> } };
    };
    expect(scanPayload.status?.embeddings).toMatchObject({
      model: 'semble-mock-code-model',
      embeddedChunks: expect.any(Number),
    });

    const refreshResult = await client.callTool({ name: 'refresh', arguments: { baseDir: projectDir, limit: 100, concurrency: 2 } });
    const refreshPayload = JSON.parse(refreshResult.content[0].text ?? '{}') as {
      diagnostics?: { model?: string; embeddedChunks?: number; actualDimensions?: Array<{ dimension: number }> };
    };
    expect(refreshPayload.diagnostics).toMatchObject({
      model: 'semble-mock-code-model',
      embeddedChunks: expect.any(Number),
    });
    expect(refreshPayload.diagnostics?.actualDimensions?.[0]).toMatchObject({ dimension: 3 });
    expect(mockEmbedding.getRequestCount()).toBeGreaterThan(0);

    const searchResult = await client.callTool({ name: 'byomem_file_search', arguments: { baseDir: projectDir, query: 'alpha', limit: 3 } });
    const searchPayload = JSON.parse(searchResult.content[0].text ?? '{}') as { results?: Array<{ chunk?: { filePath?: string } }> };
    expect(searchPayload.results?.length ?? 0).toBeGreaterThan(0);
    expect(searchPayload.results?.[0]?.chunk?.filePath).toContain(projectDir);
  });
});
