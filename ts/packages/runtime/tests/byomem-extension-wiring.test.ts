import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import extensionModule, { byomem_runtime_status, byomem_runtime_test_cleanup, byomem_runtime_test_reload_env } from '../src/pi-extension.ts';
import { openNativeStore } from '../src/store.js';

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

function readStoredRecords(dir: string): Array<any> {
  const store = openNativeStore({ baseDir: dir, embeddingModel: 'fallback-deterministic-v1' });
  try {
    return store.list();
  } finally {
    store.close();
  }
}

describe('byomem extension wiring', () => {
  const dirs: string[] = [];
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    byomem_runtime_test_cleanup();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    byomem_runtime_test_reload_env();
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
      'byomem_file_search',
      'byomem_file_search_find_related',
      'byomem_file_search_semantic_refresh',
      'byomem_file_search_status',
      'byomem_file_search_scan',
      'byomem_file_search_polling_status',
      'byomem_file_search_polling_enable',
      'byomem_file_search_polling_disable',
      'byomem_file_search_project_register',
      'byomem_file_search_project_list',
      'byomem_file_search_project_unregister',
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
    const localMock = makeMockPi();
    extensionModule(localMock.api as never);

    expect(localMock.events.session_start).toHaveLength(1);
    expect(localMock.events.before_agent_start).toHaveLength(1);
    expect(localMock.events.turn_end).toHaveLength(1);
    expect(localMock.events.session_before_switch).toHaveLength(1);
    expect(localMock.events.session_shutdown).toHaveLength(1);
  });

  it('defaults storeBaseDir to a global runtime path while keeping active project tied to cwd', async () => {
    byomem_runtime_test_reload_env();
    const status = byomem_runtime_status();
    const repoRoot = process.cwd();
    const projectKey = basename(repoRoot);

    expect(status.storeBaseDir).toBe(join(process.env.HOME ?? '', '.byomem', 'runtime'));
    expect(status.activeProject).toMatchObject({
      repoRoot,
      projectKey,
      activeProjectMetadata: {
        source: 'git',
        path: repoRoot,
        normalizedLeafName: projectKey,
      },
    });
  });

  it('uses BYOMEM_RUNTIME_BASE_DIR only for store location, not active project identity', async () => {
    const dir = tempDir();
    dirs.push(dir);
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', dir);
    byomem_runtime_test_reload_env();

    const status = byomem_runtime_status();
    const repoRoot = process.cwd();
    const projectKey = basename(repoRoot);

    expect(status.storeBaseDir).toBe(dir);
    expect(status.activeProject).toMatchObject({
      repoRoot,
      projectKey,
      activeProjectMetadata: {
        source: 'git',
        path: repoRoot,
        normalizedLeafName: projectKey,
      },
    });
  });

  it('surfaces remembered context visibly once while keeping hidden steering compact', async () => {
    const dir = tempDir();
    dirs.push(dir);
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', dir);
    vi.stubEnv('BYOMEM_EMBEDDING_DIMENSION', '8');
    byomem_runtime_test_reload_env();

    const localMock = makeMockPi();
    extensionModule(localMock.api as never);

    const notify = vi.fn();
    await localMock.events.session_start?.[0]?.({ reason: 'startup' }, { ui: { notify } });

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

    const first = await localMock.events.before_agent_start?.[0]?.(
      { prompt: 'Investigate the repo', systemPrompt: 'BASE SYSTEM PROMPT' },
      { ui: { notify } },
    );
    expect(first?.systemPrompt).toContain('## Remembered BYOMem steering');
    expect(first?.systemPrompt).toContain('- User preferences:');
    expect(first?.systemPrompt).toContain('- Project context:');
    expect(first?.systemPrompt).not.toContain('## Remembered BYOMem context');
    expect(notify).toHaveBeenCalledWith(expect.stringContaining('## Remembered BYOMem context'), 'info');
    expect(notify).toHaveBeenCalledTimes(2);

    const second = await localMock.events.before_agent_start?.[0]?.(
      { prompt: 'Follow-up task', systemPrompt: 'BASE SYSTEM PROMPT' },
      { ui: { notify } },
    );
    expect(second).toEqual({});
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('operates without durable checkpoint persistence for turn_end processing', async () => {
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
    byomem_runtime_test_reload_env();

    const localMock = makeMockPi();
    extensionModule(localMock.api as never);

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
    expect(existsSync(storePath)).toBe(false);
    const debugLogPath = join(dir, 'queue', 'debug', 'byomem-turn-end.jsonl');
    expect(existsSync(debugLogPath)).toBe(true);
    const debugLines = readFileSync(debugLogPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(debugLines.map((line) => ({ hook: line.hook, phase: line.phase, success: line.success, resolved: line.resolved }))).toEqual([
      { hook: 'turn_end', phase: 'entered', success: undefined, resolved: undefined },
      { hook: 'turn_end', phase: 'session_capture_input_resolved', success: undefined, resolved: true },
      { hook: 'turn_end', phase: 'capture_completed', success: true, resolved: undefined },
    ]);
    expect(existsSync(storePath)).toBe(false);
  });

  it('does not write anything when session info is incomplete', async () => {
    const dir = tempDir();
    dirs.push(dir);
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', dir);
    byomem_runtime_test_reload_env();

    const localMock = makeMockPi();
    extensionModule(localMock.api as never);

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
    byomem_runtime_test_reload_env();

    const localMock = makeMockPi();
    extensionModule(localMock.api as never);

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
    byomem_runtime_test_reload_env();

    const localMock = makeMockPi();
    extensionModule(localMock.api as never);

    await localMock.events.session_before_switch?.[0]?.(
      {},
      { sessionId: 'milestone-a-session', transcriptPath, ui: { notify() {} } },
    );
    await localMock.events.session_before_switch?.[0]?.(
      {},
      { sessionId: 'milestone-a-session', transcriptPath, ui: { notify() {} } },
    );
    const nativeStorePath = join(dir, 'native-store.json');
    expect(existsSync(nativeStorePath)).toBe(false);

    await localMock.events.session_shutdown?.[0]?.(
      {},
      { sessionId: 'milestone-a-session', transcriptPath, ui: { notify() {} } },
    );
    expect(existsSync(nativeStorePath)).toBe(false);
    expect(existsSync(join(dir, 'byomem-index.sqlite'))).toBe(true);
    const records = readStoredRecords(dir);
    expect(records.filter((record) => record.content.structured?.kind === 'checkpoint')).toHaveLength(0);
    const rollups = records.filter((record) => record.content.structured?.kind === 'rollup');
    expect(rollups.length).toBeGreaterThanOrEqual(1);
    expect(rollups[0]?.content.structured).toMatchObject({
      kind: 'rollup',
      sessionId: 'milestone-a-session',
      flushReason: 'final',
      sourceStableKey: 'project:byomem-session:root:milestone-a-session',
    });
    expect(Object.keys((rollups[0]?.content.structured ?? {}) as Record<string, unknown>)).toEqual(['kind', 'sessionId', 'flushReason', 'sourceStableKey']);
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
      '  fallback_model: qwen3.5:4b',
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
    byomem_runtime_test_reload_env();

    const localMock = makeMockPi();
    extensionModule(localMock.api as never);

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

    const statusTool = localMock.tools.find((tool) => tool.name === 'byomem_runtime_status');
    const status = JSON.parse((await statusTool!.execute('status', {})).content[0].text) as Record<string, unknown>;
    expect(status).toMatchObject({ summarizerModel: 'qwen3:8b', summarizerFallbackModel: 'qwen3.5:4b', activeProject: expect.any(Object), projectKey: expect.any(String) });

    expect(existsSync(join(dir, 'native-store.json'))).toBe(false);
    const records = readStoredRecords(dir);
    expect(records.filter((record) => record.content.structured?.kind === 'rollup')).toHaveLength(1);
    expect(records.find((record) => record.content.structured?.kind === 'rollup')).toMatchObject({
      content: {
        text: expect.stringContaining('Summarized pending turns'),
        structured: {
          kind: 'rollup',
          sessionId: 'milestone-a-session',
          flushReason: 'threshold',
          sourceStableKey: 'project:byomem-session:root:milestone-a-session',
        },
      },
    });
    expect(Object.keys((records.find((record) => record.content.structured?.kind === 'rollup')?.content.structured ?? {}) as Record<string, unknown>)).toEqual(['kind', 'sessionId', 'flushReason', 'sourceStableKey']);
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
    byomem_runtime_test_reload_env();

    const localMock = makeMockPi();
    extensionModule(localMock.api as never);

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
      'file_search:',
      '  embedding_batch_size: 17',
      '  embedding_concurrency: 6',
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
    byomem_runtime_test_reload_env();

    expect(byomem_runtime_status()).toMatchObject({
      embeddingConfigSource: 'config',
      embeddingConfigPath: configPath,
      embeddingBaseUrl: 'http://localhost:11434/v1',
      embeddingModel: 'test-embed-model',
      embeddingTimeoutMs: 11,
      fileSearchConfigSource: 'config',
      fileSearchConfigPath: configPath,
      fileSearchEmbeddingBatchSize: 17,
      fileSearchEmbeddingConcurrency: 6,
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

  it('reads file_search embedding batch size from env overrides', async () => {
    const dir = tempDir();
    dirs.push(dir);
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', dir);
    vi.stubEnv('BYOMEM_FILE_SEARCH_EMBEDDING_BATCH_SIZE', '23');
    byomem_runtime_test_reload_env();

    expect(byomem_runtime_status()).toMatchObject({
      fileSearchConfigSource: 'env',
      fileSearchEmbeddingBatchSize: 23,
    });
  });

  it('reads file_search embedding concurrency from env overrides', async () => {
    const dir = tempDir();
    dirs.push(dir);
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', dir);
    vi.stubEnv('BYOMEM_FILE_SEARCH_EMBEDDING_CONCURRENCY', '5');
    byomem_runtime_test_reload_env();

    expect(byomem_runtime_status()).toMatchObject({
      fileSearchConfigSource: 'env',
      fileSearchEmbeddingConcurrency: 5,
    });
  });

  it('reads file_search index storage mode from env and YAML config', async () => {
    const dir = tempDir();
    dirs.push(dir);
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', dir);
    vi.stubEnv('BYOMEM_FILE_SEARCH_INDEX_STORAGE_MODE', 'memory');
    byomem_runtime_test_reload_env();

    expect(byomem_runtime_status()).toMatchObject({
      fileSearchConfigSource: 'env',
      fileSearchIndexStorageMode: 'memory',
    });

    const configPath = join(dir, 'file-search-storage.yaml');
    writeConfig(configPath, [
      'file_search:',
      '  index_storage_mode: memory',
    ]);
    vi.unstubAllEnvs();
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', dir);
    vi.stubEnv('BYOMEM_CONFIG_PATH', configPath);
    byomem_runtime_test_reload_env();

    expect(byomem_runtime_status()).toMatchObject({
      fileSearchConfigSource: 'config',
      fileSearchConfigPath: configPath,
      fileSearchIndexStorageMode: 'memory',
    });
  });

  it('parses file_search excluded_extensions YAML forms without embedded quotes and keeps empty config lists disabling defaults', async () => {
    const dir = tempDir();
    dirs.push(dir);
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', dir);

    const bracketedConfigPath = join(dir, 'file-search-bracketed.yaml');
    writeConfig(bracketedConfigPath, [
      'file_search:',
      '  excluded_extensions: [\'txt\', ".db"]',
    ]);
    vi.stubEnv('BYOMEM_CONFIG_PATH', bracketedConfigPath);
    byomem_runtime_test_reload_env();

    expect(byomem_runtime_status()).toMatchObject({
      fileSearchConfigSource: 'config',
      fileSearchConfigPath: bracketedConfigPath,
      fileSearchScannerExcludedExtensions: ['txt', '.db'],
    });

    const blockConfigPath = join(dir, 'file-search-block.yaml');
    writeConfig(blockConfigPath, [
      'file_search:',
      '  excluded_extensions:',
      "    - 'txt'",
      '    - ".db"',
    ]);
    vi.stubEnv('BYOMEM_CONFIG_PATH', blockConfigPath);
    byomem_runtime_test_reload_env();

    expect(byomem_runtime_status()).toMatchObject({
      fileSearchConfigSource: 'config',
      fileSearchConfigPath: blockConfigPath,
      fileSearchScannerExcludedExtensions: ['txt', '.db'],
    });

    const emptyConfigPath = join(dir, 'file-search-empty.yaml');
    writeConfig(emptyConfigPath, [
      'file_search:',
      '  excluded_extensions: []',
    ]);
    vi.stubEnv('BYOMEM_CONFIG_PATH', emptyConfigPath);
    byomem_runtime_test_reload_env();

    expect(byomem_runtime_status()).toMatchObject({
      fileSearchConfigSource: 'config',
      fileSearchConfigPath: emptyConfigPath,
      fileSearchScannerExcludedExtensions: [],
    });
  });

  it('returns a minimal DTO for byomem_search results and omits support fields', async () => {
    const dir = tempDir();
    dirs.push(dir);
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', dir);
    byomem_runtime_test_reload_env();

    const mock = makeMockPi();
    extensionModule(mock.api as never);

    const tool = mock.tools.find((entry) => entry.name === 'byomem_search')!;
    const rawResults = [
      {
        id: 'rec-session',
        scope: 'project',
        identity: { namespace: 'byomem-session', leafName: 'session-a', parentContext: 'root' },
        content: {
          text: 'Session checkpoint summary',
          structured: {
            kind: 'checkpoint',
            sessionId: 'session-a',
            transcriptPreview: ['user: hello', 'assistant: hi'],
            transcriptPath: '/tmp/session.jsonl',
            transcriptBytes: 1234,
            messageCount: 2,
            retained: true,
          },
        },
        provenance: { source: 'session-capture', adapter: 'native-store' },
        metadata: { hidden: true },
      },
      {
        id: 'rec-project',
        scope: 'project',
        identity: { namespace: 'project-decisions', leafName: 'search-memory-first', parentContext: 'root' },
        content: {
          text: 'Search memory first',
          structured: {
            kind: 'note',
            transcriptPreview: ['keep me'],
            transcriptPath: '/tmp/keep.jsonl',
            transcriptBytes: 99,
            messageCount: 1,
            retained: true,
          },
        },
        provenance: { source: 'fixtures', adapter: 'native-store' },
        metadata: { hidden: false },
      },
    ];

    const searchIndexModule = await import('../src/search-index.js');
    vi.spyOn(searchIndexModule, 'searchIndex').mockResolvedValue(rawResults as never);

    const result = await tool.execute('1', { query: 'session', scope: 'project', limit: 5 });
    const parsed = JSON.parse((result as { content: { text: string }[] }).content[0].text) as { results: Array<Record<string, unknown>> };
    const detailsResults = (result as { details: { results: Array<Record<string, unknown>> } }).details.results;

    expect(parsed.results).toEqual(detailsResults);

    for (const entry of parsed.results) {
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('scope');
      expect(entry).toHaveProperty('identity');
      expect(entry).toHaveProperty('text');
      expect(entry).not.toHaveProperty('content');
      expect(entry).not.toHaveProperty('metadata');
      expect(entry).not.toHaveProperty('transcriptPreview');
      expect(entry).not.toHaveProperty('transcriptPath');
      expect(entry).not.toHaveProperty('transcriptBytes');
      expect(entry).not.toHaveProperty('messageCount');
      expect(entry).not.toHaveProperty('provenance.adapter');
      expect(Object.keys(entry)).toEqual(expect.arrayContaining(['id', 'scope', 'identity', 'text']));
    }

    for (const entry of parsed.results) {
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('scope');
      expect(entry).toHaveProperty('identity');
      expect(entry).toHaveProperty('text');
      expect(entry).not.toHaveProperty('content');
      expect(entry).not.toHaveProperty('metadata');
      expect(entry).not.toHaveProperty('transcriptPreview');
      expect(entry).not.toHaveProperty('transcriptPath');
      expect(entry).not.toHaveProperty('transcriptBytes');
      expect(entry).not.toHaveProperty('messageCount');
      expect(entry).not.toHaveProperty('provenance.adapter');
      const structured = entry.structured as Record<string, unknown> | undefined;
      if (structured) expect(Object.keys(structured)).toEqual(['kind']);
      const provenance = entry.provenance as Record<string, unknown> | undefined;
      if (provenance) expect(Object.keys(provenance)).toEqual(['source']);
    }
  });

  it('normalizes store and prune intents before write-path execution', async () => {
    const dir = tempDir();
    dirs.push(dir);
    vi.stubEnv('BYOMEM_RUNTIME_BASE_DIR', dir);
    byomem_runtime_test_reload_env();

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

    const sensitiveResult = await storeTool!.execute('2', {
      scope: 'project',
      identity: { namespace: 'x', leafName: 'z', parentContext: 'root' },
      content: { text: '{"thinkingSignature":"hidden-signature"}', structured: { encrypted_content: 'opaque-payload', keep: 'safe' } },
      provenance: { source: 'prompt-mode' },
    }) as { content: { text: string }[] };
    expect(sensitiveResult.content[0].text).not.toContain('thinkingSignature');
    expect(sensitiveResult.content[0].text).not.toContain('hidden-signature');
    expect(sensitiveResult.content[0].text).not.toContain('encrypted_content');
    expect(sensitiveResult.content[0].text).not.toContain('opaque-payload');
    expect(sensitiveResult.content[0].text).toContain('safe');

    await expect(pruneTool!.execute('1', {
      id: 'project:x:root:y',
      scope: 'project',
    })).resolves.toMatchObject({ content: [{ type: 'text' }] });
  });
});
