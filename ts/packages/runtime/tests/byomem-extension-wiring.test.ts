import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extensionModule, { byomem_runtime_status } from '../../../../.pi/extensions/byomem/index.ts';

type RegisteredTool = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (...args: any[]) => Promise<unknown>;
};

function makeMockPi() {
  const tools: RegisteredTool[] = [];
  const commands: Record<string, { description: string; handler: (...args: any[]) => Promise<void> }> = {};
  return {
    tools,
    commands,
    api: {
      on: () => undefined,
      registerTool(tool: RegisteredTool) {
        tools.push(tool);
      },
      registerCommand(name: string, command: { description: string; handler: (...args: any[]) => Promise<void> }) {
        commands[name] = command;
      },
    },
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'byomem-extension-wiring-'));
}

describe('byomem extension wiring', () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it('registers the project-local TS-native tools and command without python', async () => {
    const mock = makeMockPi();
    extensionModule(mock.api as never);

    expect(mock.commands['byomem-status']).toBeTruthy();
    expect(mock.tools.map((tool) => tool.name)).toEqual([
      'byomem_runtime_status',
      'byomem_search',
      'byomem_store',
      'byomem_prune',
    ]);
    expect(mock.tools.find((tool) => tool.name === 'byomem_runtime_status')!.parameters).toEqual({
      type: 'object',
      properties: {},
    });
    expect(mock.tools.find((tool) => tool.name === 'byomem_search')!.parameters).toMatchObject({
      type: 'object',
      properties: {
        query: { type: 'string' },
        scope: { type: 'string', enum: ['project', 'dir', 'user', 'agent'] },
        limit: { type: 'number' },
      },
      required: ['query'],
      additionalProperties: false,
    });
    expect(mock.tools.find((tool) => tool.name === 'byomem_store')!.parameters).toMatchObject({
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['project', 'dir', 'user', 'agent'] },
        identity: {
          type: 'object',
          properties: {
            namespace: { type: 'string' },
            leafName: { type: 'string' },
            parentContext: { type: 'string' },
            stableKey: { type: 'string' },
          },
          required: ['namespace', 'leafName'],
          additionalProperties: false,
        },
        content: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            structured: { type: 'object' },
          },
          additionalProperties: false,
        },
        provenance: {
          type: 'object',
          properties: {},
          additionalProperties: true,
        },
      },
      required: ['scope', 'identity', 'content'],
      additionalProperties: false,
    });
    expect(mock.tools.find((tool) => tool.name === 'byomem_prune')!.parameters).toMatchObject({
      type: 'object',
      properties: {
        id: { type: 'string' },
        scope: { type: 'string', enum: ['project', 'dir', 'user', 'agent'] },
        identity: {
          type: 'object',
          properties: {
            namespace: { type: 'string' },
            leafName: { type: 'string' },
            parentContext: { type: 'string' },
            stableKey: { type: 'string' },
          },
          required: ['namespace', 'leafName'],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    });

    const statusTool = mock.tools.find((tool) => tool.name === 'byomem_runtime_status');
    const status = await statusTool!.execute('1', {});
    expect(JSON.parse((status as { content: { text: string }[] }).content[0].text)).toMatchObject({
      packageSurface: 'ts/packages/runtime',
      pythonDefaultDisabled: true,
    });
    expect(byomem_runtime_status().pythonDefaultDisabled).toBe(true);
  });

  it('reports config-driven embedding settings in runtime status', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const configPath = join(dir, 'config.yaml');
    writeFileSync(
      configPath,
      [
        'embeddings:',
        '  base_url: http://localhost:11434/v1',
        '  model: test-embed-model',
        '  request_timeout: 11',
      ].join('\n'),
      'utf8',
    );
    vi.stubEnv('BYOMEM_CONFIG_PATH', configPath);
    vi.resetModules();

    const { byomem_runtime_status: statusFn } = await import('../../../../.pi/extensions/byomem/index.ts');
    expect(statusFn()).toMatchObject({
      embeddingConfigSource: 'config',
      embeddingConfigPath: configPath,
      embeddingBaseUrl: 'http://localhost:11434/v1',
      embeddingModel: 'test-embed-model',
      embeddingTimeoutMs: 11,
    });
  });

  it('searches the native store via the extension tool against the real repo store', async () => {
    const mock = makeMockPi();
    extensionModule(mock.api as never);

    const searchTool = mock.tools.find((tool) => tool.name === 'byomem_search');
    const result = await searchTool!.execute('1', { query: 'extension wiring', scope: 'project', limit: 5 });
    expect(result).toMatchObject({ content: [{ type: 'text' }] });
  });

  it('normalizes store and prune intents before write-path execution', async () => {
    const mock = makeMockPi();
    extensionModule(mock.api as never);

    const storeTool = mock.tools.find((tool) => tool.name === 'byomem_store');
    const pruneTool = mock.tools.find((tool) => tool.name === 'byomem_prune');

    await expect(storeTool!.execute('1', {
      scope: 'project',
      identity: { namespace: 'x', leafName: 'y', parentContext: 'root' },
      content: { text: '  hello  ' },
      provenance: { source: 'prompt-mode' },
    })).resolves.toMatchObject({ content: [{ type: 'text' }] });

    await expect(pruneTool!.execute('1', {
      id: 'project:x:root:y',
      scope: 'project',
    })).resolves.toMatchObject({ content: [{ type: 'text' }] });
  });
});
