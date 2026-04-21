import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import extensionModule, { byomem_runtime_status } from '../src/pi-extension.ts';

type RegisteredTool = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (...args: any[]) => Promise<unknown>;
};

type TranscriptTurn = { id: string; user: string; assistant: string; timestamp?: string };

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

function writeConfig(path: string, lines: string[]): void {
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

function writeEventTranscript(path: string, turns: TranscriptTurn[]): void {
  const lines: string[] = [
    JSON.stringify({ type: 'session', version: 3, id: 'milestone-a-session', timestamp: '2026-04-20T00:00:00.000Z' }),
  ];

  for (const turn of turns) {
    lines.push(JSON.stringify({
      type: 'message',
      id: `${turn.id}-user`,
      timestamp: turn.timestamp ?? '2026-04-20T00:00:00.000Z',
      message: {
        role: 'user',
        content: [{ type: 'text', text: turn.user }],
        timestamp: turn.timestamp ?? '2026-04-20T00:00:00.000Z',
      },
    }));
    lines.push(JSON.stringify({
      type: 'message',
      id: `${turn.id}-assistant`,
      parentId: `${turn.id}-user`,
      timestamp: turn.timestamp ?? '2026-04-20T00:00:01.000Z',
      message: {
        role: 'assistant',
        parentId: `${turn.id}-user`,
        content: [{ type: 'text', text: turn.assistant }],
        timestamp: turn.timestamp ?? '2026-04-20T00:00:01.000Z',
      },
    }));
  }

  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

describe('byomem extension wiring', () => {
  const dirs: string[] = [];
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
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

  it('registers the active session capture and context hooks', async () => {
    vi.resetModules();

    const mod = await import('../src/pi-extension.ts');
    const localMock = makeMockPi();
    mod.default(localMock.api as never);

    expect(localMock.events.session_start).toHaveLength(1);
    expect(localMock.events.before_agent_start).toHaveLength(1);
    expect(localMock.events.turn_end).toHaveLength(1);
    expect(localMock.events.session_before_switch).toHaveLength(1);
    expect(localMock.events.session_shutdown).toHaveLength(1);
  });

  it('injects remembered user preferences and project context on the first agent start of a session', async () => {
    const dir = tempDir();
    dirs.push(dir);
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', dir);
    vi.resetModules();

    const { default: mod } = await import('../src/pi-extension.ts');
    const localMock = makeMockPi();
    mod(localMock.api as never);

    await localMock.events.session_start?.[0]?.({ reason: 'startup' }, { ui: { notify() {} } });

    const storeTool = localMock.tools.find((tool) => tool.name === 'byomem_store');
    await storeTool!.execute('1', {
      scope: 'user',
      identity: { namespace: 'working-preferences', leafName: 'progress-update-intervals', parentContext: 'communication' },
      content: { text: 'User prefers brief progress updates at roughly 10%, 20%, 30% completion.' },
      provenance: { source: 'fixtures' },
    });
    await storeTool!.execute('2', {
      scope: 'project',
      identity: { namespace: 'project-decisions', leafName: 'search-memory-first', parentContext: 'root' },
      content: { text: 'Search project memory for architecture decisions and prior fixes before starting code changes.' },
      provenance: { source: 'fixtures' },
    });

    const result = await localMock.events.before_agent_start?.[0]?.(
      { prompt: 'Investigate the repo', systemPrompt: 'BASE SYSTEM PROMPT' },
      {},
    );
    expect(result?.systemPrompt).toContain('## Remembered BYOMem context');
    expect(result?.systemPrompt).toContain('User prefers brief progress updates');
    expect(result?.systemPrompt).toContain('Search project memory for architecture decisions');

    const second = await localMock.events.before_agent_start?.[0]?.(
      { prompt: 'Follow-up task', systemPrompt: 'BASE SYSTEM PROMPT' },
      {},
    );
    expect(second).toEqual({});
  });

  it('persists a resolved turn_end checkpoint without python bridge assumptions', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const transcriptPath = join(dir, 'session.jsonl');
    const configPath = join(dir, 'config.yaml');
    writeConfig(configPath, [
      'session_capture:',
      '  enabled: true',
      '  threshold_turns: 2',
      '  min_turns: 2',
    ]);
    writeFileSync(transcriptPath, ['user: hello', 'assistant: hi there'].join('\n'), 'utf8');
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', dir);
    vi.stubEnv('BYOMEM_CONFIG_PATH', configPath);
    vi.resetModules();

    const mod = await import('../src/pi-extension.ts');
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
    const debugLogPath = join(dir, 'queue', 'debug', 'byomem-turn-end.jsonl');
    expect(existsSync(debugLogPath)).toBe(true);
    const debugLines = readFileSync(debugLogPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(debugLines.map((line) => ({ hook: line.hook, phase: line.phase, success: line.success, resolved: line.resolved }))).toEqual([
      { hook: 'turn_end', phase: 'entered', success: undefined, resolved: undefined },
      { hook: 'turn_end', phase: 'session_capture_input_resolved', success: undefined, resolved: true },
      { hook: 'turn_end', phase: 'capture_completed', success: true, resolved: undefined },
    ]);
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
        structured: expect.objectContaining({
          kind: 'checkpoint',
          sessionId: 'milestone-a-session',
          event: 'turn_end',
          final: false,
          idle: false,
          pendingTurns: 1,
          transcriptPath,
          transcriptPreview: ['user: hello', 'assistant: hi there'],
        }),
      },
    });
  });

  it('does not write anything when session info is incomplete', async () => {
    const dir = tempDir();
    dirs.push(dir);
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', dir);
    vi.resetModules();

    const mod = await import('../src/pi-extension.ts');
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

    const mod = await import('../src/pi-extension.ts');
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

  it('persists lifecycle hook payloads with expected final and idle semantics', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const transcriptPath = join(dir, 'session.jsonl');
    const configPath = join(dir, 'config.yaml');
    writeConfig(configPath, [
      'session_capture:',
      '  enabled: true',
      '  threshold_turns: 99',
      '  min_turns: 2',
    ]);
    writeFileSync(transcriptPath, ['user: hello', 'assistant: hi there'].join('\n'), 'utf8');
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', dir);
    vi.stubEnv('BYOMEM_CONFIG_PATH', configPath);
    vi.resetModules();

    const mod = await import('../src/pi-extension.ts');
    const localMock = makeMockPi();
    mod.default(localMock.api as never);

    await localMock.events.session_before_switch?.[0]?.(
      {},
      { sessionId: 'milestone-a-session', transcriptPath, ui: { notify() {} } },
    );
    let snapshot = JSON.parse(readFileSync(join(dir, 'native-store.json'), 'utf8')) as { records: Array<any> };
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.records[0].content.structured).toMatchObject({ event: 'session_before_switch', final: false, idle: false });

    await localMock.events.session_shutdown?.[0]?.(
      {},
      { sessionId: 'milestone-a-session', transcriptPath, ui: { notify() {} } },
    );
    snapshot = JSON.parse(readFileSync(join(dir, 'native-store.json'), 'utf8')) as { records: Array<any> };
    expect(snapshot.records.find((record) => record.provenance.origin === 'session-capture')?.content.structured).toMatchObject({ event: 'session_shutdown', final: true, idle: false });

    await localMock.events.session_before_switch?.[0]?.(
      {},
      { sessionId: 'milestone-a-session', transcriptPath, idle: true, ui: { notify() {} } },
    );
    snapshot = JSON.parse(readFileSync(join(dir, 'native-store.json'), 'utf8')) as { records: Array<any> };
    expect(snapshot.records.find((record) => record.provenance.origin === 'session-capture')?.content.structured).toMatchObject({ event: 'session_before_switch', final: false, idle: true });
  });

  it('uses summarizer config to trigger TS rollups on threshold flush', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const transcriptPath = join(dir, 'session.jsonl');
    const configPath = join(dir, 'config.yaml');
    writeConfig(configPath, [
      'summarizer:',
      '  base_url: http://localhost:11434/v1',
      '  model: qwen3:8b',
      '  ollama_num_ctx: 16384',
      'session_capture:',
      '  enabled: true',
      '  threshold_turns: 2',
      '  min_turns: 2',
    ]);
    const calls: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify({ message: { content: '- Summarized pending turns\nFinal sentence.' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', dir);
    vi.stubEnv('BYOMEM_CONFIG_PATH', configPath);
    vi.resetModules();

    const mod = await import('../src/pi-extension.ts');
    const localMock = makeMockPi();
    mod.default(localMock.api as never);

    writeEventTranscript(transcriptPath, [
      { id: 'turn-1', user: 'What changed?', assistant: 'Checkpoint capture was restored.' },
    ]);
    await localMock.events.turn_end?.[0]?.(
      {},
      {
        sessionManager: {
          getSessionId: () => 'milestone-a-session',
          getSessionFile: () => transcriptPath,
          getEntries: () => [{}, {}],
        },
        ui: { notify() {} },
      },
    );

    writeEventTranscript(transcriptPath, [
      { id: 'turn-1', user: 'What changed?', assistant: 'Checkpoint capture was restored.' },
      { id: 'turn-2', user: 'When should qwen run?', assistant: 'On threshold, idle, or final flush.' },
    ]);
    await localMock.events.turn_end?.[0]?.(
      {},
      {
        sessionManager: {
          getSessionId: () => 'milestone-a-session',
          getSessionFile: () => transcriptPath,
          getEntries: () => [{}, {}, {}, {}],
        },
        ui: { notify() {} },
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/api/chat');
    expect(calls[0]?.body).toMatchObject({ model: 'qwen3:8b', stream: false, options: { num_ctx: 16384 } });

    const snapshot = JSON.parse(readFileSync(join(dir, 'native-store.json'), 'utf8')) as { records: Array<any> };
    expect(snapshot.records.filter((record) => record.provenance.origin === 'session-rollup')).toHaveLength(1);
    expect(snapshot.records.find((record) => record.provenance.origin === 'session-rollup')).toMatchObject({
      content: {
        text: expect.stringContaining('Summarized pending turns'),
        structured: {
          kind: 'rollup',
          flushReason: 'threshold',
          pendingTurns: 2,
          pendingTurnIds: ['turn-1-user', 'turn-2-user'],
        },
      },
    });
  });

  it('infers Ollama native chat transport from summarizer base URL without num_ctx', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const transcriptPath = join(dir, 'session.jsonl');
    const configPath = join(dir, 'config.yaml');
    writeConfig(configPath, [
      'summarizer:',
      '  base_url: http://localhost:11434/v1',
      '  model: qwen3:8b',
      'session_capture:',
      '  enabled: true',
      '  threshold_turns: 2',
      '  min_turns: 2',
    ]);
    const calls: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify({ message: { content: '- Summarized pending turns\nFinal sentence.' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', dir);
    vi.stubEnv('BYOMEM_CONFIG_PATH', configPath);
    vi.resetModules();

    const mod = await import('../src/pi-extension.ts');
    const localMock = makeMockPi();
    mod.default(localMock.api as never);

    writeEventTranscript(transcriptPath, [
      { id: 'turn-1', user: 'What changed?', assistant: 'Checkpoint capture was restored.' },
      { id: 'turn-2', user: 'What now?', assistant: 'Use the summarizer for rollups.' },
    ]);
    await localMock.events.turn_end?.[0]?.(
      {},
      {
        sessionManager: {
          getSessionId: () => 'milestone-b-session',
          getSessionFile: () => transcriptPath,
          getEntries: () => [{}, {}, {}, {}],
        },
        ui: { notify() {} },
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/api/chat');
    expect(calls[0]?.body).toMatchObject({ model: 'qwen3:8b', stream: false });
    expect(calls[0]?.body?.options).toBeUndefined();
  });

  it('reports config-driven embedding, summarizer, and session-capture settings in runtime status', async () => {
    const dir = tempDir();
    dirs.push(dir);
    const configPath = join(dir, 'config.yaml');
    writeConfig(configPath, [
      'embeddings:',
      '  base_url: http://localhost:11434/v1',
      '  model: test-embed-model',
      '  request_timeout: 11',
      'summarizer:',
      '  base_url: http://localhost:11434/v1',
      '  model: qwen3:8b',
      '  ollama_num_ctx: 16384',
      'session_capture:',
      '  enabled: true',
      '  threshold_turns: 2',
      '  large_turn_chars: 100',
      '  idle_flush_seconds: 90',
      '  min_turns: 2',
    ]);
    vi.stubEnv('BYOMEM_CONFIG_PATH', configPath);
    vi.resetModules();

    const { byomem_runtime_status: statusFn } = await import('../src/pi-extension.ts');
    expect(statusFn()).toMatchObject({
      embeddingConfigSource: 'config',
      embeddingConfigPath: configPath,
      embeddingBaseUrl: 'http://localhost:11434/v1',
      embeddingModel: 'test-embed-model',
      embeddingTimeoutMs: 11,
      summarizerConfigSource: 'config',
      summarizerConfigPath: configPath,
      summarizerBaseUrl: 'http://localhost:11434/v1',
      summarizerModel: 'qwen3:8b',
      summarizerOllamaNumCtx: 16384,
      sessionCaptureConfigSource: 'config',
      sessionCaptureEnabled: true,
      sessionCaptureThresholdTurns: 2,
      sessionCaptureLargeTurnChars: 100,
      sessionCaptureIdleFlushSeconds: 90,
      sessionCaptureMinTurns: 2,
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
