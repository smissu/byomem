import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerOperationsTools } from '../src/mcp/operations-tools.js';

type RegisteredTool = {
  name: string;
  execute: (params: Record<string, unknown>) => Promise<unknown> | unknown;
};

function makeMockServer(): { tools: RegisteredTool[]; server: { registerTool: (name: string, meta: unknown, execute: RegisteredTool['execute']) => void } } {
  const tools: RegisteredTool[] = [];
  return {
    tools,
    server: {
      registerTool(name: string, _meta: unknown, execute: RegisteredTool['execute']) {
        tools.push({ name, execute });
      },
    },
  };
}

function parsePayload(result: unknown): Record<string, unknown> {
  const text = String((result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '{}');
  return JSON.parse(text) as Record<string, unknown>;
}

describe('Sprint 70 file-search worker isolation', () => {
  const dirs: string[] = [];
  const originalWorkerPath = process.env.BYOMEM_FILE_SEARCH_WORKER_PATH;
  const originalTimeout = process.env.BYOMEM_FILE_SEARCH_WORKER_TIMEOUT_MS;
  const originalMaxConcurrency = process.env.BYOMEM_FILE_SEARCH_WORKER_MAX_CONCURRENCY;
  const originalQueueDepth = process.env.BYOMEM_FILE_SEARCH_WORKER_QUEUE_DEPTH;

  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
    if (originalWorkerPath === undefined) delete process.env.BYOMEM_FILE_SEARCH_WORKER_PATH;
    else process.env.BYOMEM_FILE_SEARCH_WORKER_PATH = originalWorkerPath;
    if (originalTimeout === undefined) delete process.env.BYOMEM_FILE_SEARCH_WORKER_TIMEOUT_MS;
    else process.env.BYOMEM_FILE_SEARCH_WORKER_TIMEOUT_MS = originalTimeout;
    if (originalMaxConcurrency === undefined) delete process.env.BYOMEM_FILE_SEARCH_WORKER_MAX_CONCURRENCY;
    else process.env.BYOMEM_FILE_SEARCH_WORKER_MAX_CONCURRENCY = originalMaxConcurrency;
    if (originalQueueDepth === undefined) delete process.env.BYOMEM_FILE_SEARCH_WORKER_QUEUE_DEPTH;
    else process.env.BYOMEM_FILE_SEARCH_WORKER_QUEUE_DEPTH = originalQueueDepth;
  });

  function workerTool() {
    const server = makeMockServer();
    registerOperationsTools(server.server as never, () => { throw new Error('parent runtime should not be used for worker-routed file-search'); }, { groups: ['file-search'], fileSearchExecution: 'worker' });
    const tool = server.tools.find((candidate) => candidate.name === 'byomem_file_search');
    expect(tool).toBeDefined();
    return tool!;
  }

  it('returns sanitized structured failure when the worker exits after writing sensitive stderr', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'byomem-s70-worker-fail-'));
    dirs.push(dir);
    const workerPath = join(dir, 'worker.js');
    writeFileSync(workerPath, "process.stderr.write('SECRET_CHUNK_TEXT should not leak'); process.exit(137);\n", 'utf8');
    process.env.BYOMEM_FILE_SEARCH_WORKER_PATH = workerPath;

    const result = await workerTool().execute({ query: 'needle' });
    const payload = parsePayload(result);
    expect(payload.error).toMatchObject({
      kind: 'worker_failure',
      exitCode: 137,
      retryable: true,
      reason: 'exit',
    });
    expect(JSON.stringify(payload)).not.toContain('SECRET_CHUNK_TEXT');
  });

  it('keeps the parent tool callable after malformed and successful worker responses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'byomem-s70-worker-retry-'));
    dirs.push(dir);
    const workerPath = join(dir, 'worker.js');
    process.env.BYOMEM_FILE_SEARCH_WORKER_PATH = workerPath;

    writeFileSync(workerPath, "process.stdout.write('not-json');\n", 'utf8');
    const malformed = parsePayload(await workerTool().execute({ query: 'needle' }));
    expect(malformed.error).toMatchObject({ kind: 'worker_failure', reason: 'malformed-response' });

    writeFileSync(workerPath, "process.stdout.write(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ ok: true }) }], details: { ok: true }, ok: true }) + '\\n');\n", 'utf8');
    const success = parsePayload(await workerTool().execute({ query: 'needle' }));
    expect(success).toEqual({ ok: true });
  });

  it('returns timeout without closing the parent process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'byomem-s70-worker-timeout-'));
    dirs.push(dir);
    const workerPath = join(dir, 'worker.js');
    writeFileSync(workerPath, "setTimeout(() => process.stdout.write('{}'), 1000);\n", 'utf8');
    process.env.BYOMEM_FILE_SEARCH_WORKER_PATH = workerPath;
    process.env.BYOMEM_FILE_SEARCH_WORKER_TIMEOUT_MS = '25';

    const timeout = parsePayload(await workerTool().execute({ query: 'needle' }));
    expect(timeout.error).toMatchObject({ kind: 'worker_failure', reason: 'timeout', signal: 'SIGKILL' });
  });

  it('returns structured backpressure when the worker queue is saturated', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'byomem-s70-worker-backpressure-'));
    dirs.push(dir);
    const workerPath = join(dir, 'worker.js');
    writeFileSync(workerPath, "setTimeout(() => process.stdout.write(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }) + '\\n'), 100);\n", 'utf8');
    process.env.BYOMEM_FILE_SEARCH_WORKER_PATH = workerPath;
    process.env.BYOMEM_FILE_SEARCH_WORKER_MAX_CONCURRENCY = '1';
    process.env.BYOMEM_FILE_SEARCH_WORKER_QUEUE_DEPTH = '0';

    const tool = workerTool();
    const [first, second] = await Promise.all([
      tool.execute({ query: 'first' }),
      tool.execute({ query: 'second' }),
    ]);
    const payloads = [parsePayload(first), parsePayload(second)];
    expect(payloads.some((payload) => (payload.error as { reason?: string } | undefined)?.reason === 'backpressure')).toBe(true);
    expect(payloads.some((payload) => JSON.stringify(payload).includes('"ok":true'))).toBe(true);
  });
});
