import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('Sprint 47 operations MCP server hardening', () => {
  const transports: StdioClientTransport[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (transports.length) {
      await transports.pop()!.close();
    }
  });

  it('exposes file-search registry and polling controls with active-project defaults and stable JSON DTOs over stdio', async () => {
    const runtimeDir = makeTempDir('byomem-operations-s47-runtime-');
    const projectDir = makeTempDir('byomem-operations-s47-project-');
    mkdirSync(join(projectDir, 'notes'), { recursive: true });
    writeFileSync(join(projectDir, 'notes', 'file-search-target.txt'), 'byomem file-search tool needle unique target text\n', 'utf8');
    const operationsPath = join(process.cwd(), 'ts/packages/runtime/dist/mcp/operations.js');

    const transport = new StdioClientTransport({
      command: 'node',
      args: [operationsPath],
      cwd: projectDir,
      env: {
        ...process.env,
        BYOMEM_RUNTIME_BASE_DIR: runtimeDir,
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
      results?: Array<{ file?: { path?: string; chunk_text?: string } }>;
      semantic?: Record<string, unknown>;
    };
    expect(fileSearchPayload.results?.[0]).toMatchObject({
      file: {
        path: join(canonicalProjectDir, 'notes', 'file-search-target.txt'),
      },
    });
    expect(fileSearchPayload.results?.[0]?.file?.chunk_text).toContain('needle');

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
});
