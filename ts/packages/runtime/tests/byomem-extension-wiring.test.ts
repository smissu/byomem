import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
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
  const events: Record<string, Array<(...args: any[]) => any>> = {};
  return {
    tools,
    commands,
    events,
    api: {
      on(name: string, handler: (...args: any[]) => any) {
        events[name] ??= [];
        events[name].push(handler);
      },
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



  it('registers Milestone A session capture hooks for active extension wiring', async () => {
    vi.resetModules();

    const mod = await import('../../../../.pi/extensions/byomem/index.ts');
    const localMock = makeMockPi();
    mod.default(localMock.api as never);

    expect(localMock.events.session_start).toHaveLength(1);
    expect(localMock.events.turn_end).toHaveLength(1);
    expect(localMock.events.session_before_switch).toHaveLength(1);
    expect(localMock.events.session_shutdown).toHaveLength(1);
  });

  it('persists a resolved turn_end hook payload to the TS-native store without python bridge assumptions', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const transcriptPath = join(dir, 'session.jsonl');
    writeFileSync(transcriptPath, ['user: hello', 'assistant: hi there'].join('\n'), 'utf8');
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', dir);
    vi.resetModules();

    const mod = await import('../../../../.pi/extensions/byomem/index.ts');
    const localMock = makeMockPi();
    mod.default(localMock.api as never);

    const turnEndHandler = localMock.events.turn_end?.[0];
    expect(turnEndHandler).toBeTypeOf('function');

    await turnEndHandler?.(
      { messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi there' }] },
      {
        sessionManager: {
          getSessionId: () => 'milestone-a-session',
          getSessionFile: () => transcriptPath,
          getEntries: () => [{}, {}],
        },
        ui: { notify() {} },
      },
    );

    const storePath = join(dir, 'native-store.json');
    expect(existsSync(storePath)).toBe(true);
    const snapshot = JSON.parse(readFileSync(storePath, 'utf8')) as { version: number; records: Array<any> };
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.records[0]).toMatchObject({
      scope: 'project',
      identity: {
        namespace: 'byomem-session',
        leafName: 'milestone-a-session',
        parentContext: 'root',
      },
      provenance: {
        source: 'session-capture',
        adapter: 'native-store',
        origin: 'session-capture',
      },
      content: {
        text: 'Session milestone-a-session checkpoint from turn_end',
        structured: {
          sessionId: 'milestone-a-session',
          event: 'turn_end',
          final: false,
          messageCount: 2,
          transcriptPath,
          transcriptPreview: ['user: hello', 'assistant: hi there'],
        },
      },
    });
  });

  it('does not write anything when session info is incomplete', async () => {
    const dir = tempDir();
    dirs.push(dir);
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', dir);
    vi.resetModules();

    const mod = await import('../../../../.pi/extensions/byomem/index.ts');
    const localMock = makeMockPi();
    mod.default(localMock.api as never);

    const turnEndHandler = localMock.events.turn_end?.[0];
    await turnEndHandler?.(
      { messages: [{ role: 'user', content: 'hello' }] },
      { ui: { notify() {} } },
    );

    expect(existsSync(join(dir, 'native-store.json'))).toBe(false);
  });

  it('fails soft when transcript path is missing or unreadable', async () => {
    const dir = tempDir();
    dirs.push(dir);
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', dir);
    vi.resetModules();

    const mod = await import('../../../../.pi/extensions/byomem/index.ts');
    const localMock = makeMockPi();
    mod.default(localMock.api as never);

    const turnEndHandler = localMock.events.turn_end?.[0];
    await expect(turnEndHandler?.(
      { messages: [{ role: 'user', content: 'hello' }] },
      {
        sessionManager: {
          getSessionId: () => 'missing-session',
          getSessionFile: () => join(dir, 'missing.jsonl'),
          getEntries: () => [{}],
        },
        ui: { notify() {} },
      },
    )).resolves.toBeUndefined();

    expect(existsSync(join(dir, 'native-store.json'))).toBe(false);
  });

  it('persists lifecycle hook payloads with expected final semantics', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const transcriptPath = join(dir, 'session.jsonl');
    writeFileSync(transcriptPath, ['user: hello', 'assistant: hi there'].join('\n'), 'utf8');
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', dir);
    vi.resetModules();

    const mod = await import('../../../../.pi/extensions/byomem/index.ts');
    const localMock = makeMockPi();
    mod.default(localMock.api as never);

    await localMock.events.session_before_switch?.[0]?.(
      {},
      { sessionId: 'milestone-a-session', transcriptPath, ui: { notify() {} } },
    );
    let snapshot = JSON.parse(readFileSync(join(dir, 'native-store.json'), 'utf8')) as { records: Array<any> };
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.records[0].content.structured).toMatchObject({ event: 'session_before_switch', final: false });

    await localMock.events.session_shutdown?.[0]?.(
      {},
      { sessionId: 'milestone-a-session', transcriptPath, ui: { notify() {} } },
    );
    snapshot = JSON.parse(readFileSync(join(dir, 'native-store.json'), 'utf8')) as { records: Array<any> };
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.records[0].content.structured).toMatchObject({ event: 'session_shutdown', final: true });
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
