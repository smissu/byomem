import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { safeJson } from './readonly-core.js';

export const FILE_SEARCH_WORKER_DEFAULT_TIMEOUT_MS = 30_000;
export const FILE_SEARCH_WORKER_DEFAULT_MAX_OLD_SPACE_MB = 256;
export const FILE_SEARCH_WORKER_DEFAULT_MAX_CONCURRENCY = 1;
export const FILE_SEARCH_WORKER_DEFAULT_QUEUE_DEPTH = 8;
export const FILE_SEARCH_WORKER_STDIO_MAX_BYTES = 1024 * 1024;

export type FileSearchWorkerToolName =
  | 'scan'
  | 'refresh'
  | 'byomem_file_search'
  | 'byomem_file_search_find_related'
  | 'byomem_file_search_project_register'
  | 'byomem_file_search_project_list'
  | 'byomem_file_search_project_unregister'
  | 'byomem_file_search_polling_status'
  | 'byomem_file_search_polling_enable'
  | 'byomem_file_search_polling_disable';

export interface FileSearchWorkerRequest {
  toolName: FileSearchWorkerToolName;
  params: unknown;
}

export interface FileSearchWorkerFailure {
  kind: 'worker_failure';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timeoutMs?: number;
  memoryLimitMb: number;
  retryable: boolean;
  recoveryHint: string;
  reason: 'exit' | 'signal' | 'timeout' | 'malformed-response' | 'oversized-output' | 'spawn-error' | 'backpressure';
}

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function parseNonNegativeIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(raw)) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

export function resolveFileSearchWorkerConfig(): { timeoutMs: number; memoryLimitMb: number; maxConcurrency: number; queueDepth: number; workerPath: string } {
  const here = dirname(fileURLToPath(import.meta.url));
  return {
    timeoutMs: parsePositiveIntegerEnv('BYOMEM_FILE_SEARCH_WORKER_TIMEOUT_MS', FILE_SEARCH_WORKER_DEFAULT_TIMEOUT_MS),
    memoryLimitMb: parsePositiveIntegerEnv('BYOMEM_FILE_SEARCH_WORKER_MAX_OLD_SPACE_MB', FILE_SEARCH_WORKER_DEFAULT_MAX_OLD_SPACE_MB),
    maxConcurrency: parsePositiveIntegerEnv('BYOMEM_FILE_SEARCH_WORKER_MAX_CONCURRENCY', FILE_SEARCH_WORKER_DEFAULT_MAX_CONCURRENCY),
    queueDepth: parseNonNegativeIntegerEnv('BYOMEM_FILE_SEARCH_WORKER_QUEUE_DEPTH', FILE_SEARCH_WORKER_DEFAULT_QUEUE_DEPTH),
    workerPath: process.env.BYOMEM_FILE_SEARCH_WORKER_PATH?.trim() || resolve(here, 'file-search-worker.js'),
  };
}

function failurePayload(toolName: FileSearchWorkerToolName, failure: FileSearchWorkerFailure) {
  const payload = { tool: toolName, error: failure, worker: { isolated: true } };
  return {
    content: [{ type: 'text' as const, text: safeJson(payload) }],
    details: payload,
    ...payload,
  };
}

let activeWorkerCount = 0;
let queuedWorkerCount = 0;
const workerWaiters: Array<() => void> = [];

async function acquireWorkerSlot(config: ReturnType<typeof resolveFileSearchWorkerConfig>, toolName: FileSearchWorkerToolName): Promise<unknown | undefined> {
  if (activeWorkerCount < config.maxConcurrency) {
    activeWorkerCount += 1;
    return undefined;
  }
  if (queuedWorkerCount >= config.queueDepth) {
    return failurePayload(toolName, {
      kind: 'worker_failure',
      exitCode: null,
      signal: null,
      memoryLimitMb: config.memoryLimitMb,
      retryable: true,
      recoveryHint: 'Retry after in-flight file-search worker operations complete or increase BYOMEM_FILE_SEARCH_WORKER_QUEUE_DEPTH.',
      reason: 'backpressure',
    });
  }
  queuedWorkerCount += 1;
  await new Promise<void>((resolveQueued) => workerWaiters.push(resolveQueued));
  queuedWorkerCount -= 1;
  return undefined;
}

function releaseWorkerSlot(): void {
  const next = workerWaiters.shift();
  if (next) {
    next();
    return;
  }
  activeWorkerCount = Math.max(0, activeWorkerCount - 1);
}

async function executeFileSearchWorker(request: FileSearchWorkerRequest, config: ReturnType<typeof resolveFileSearchWorkerConfig>): Promise<unknown> {
  const child = spawn(process.execPath, [`--max-old-space-size=${config.memoryLimitMb}`, config.workerPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BYOMEM_RUNTIME_BASE_DIR: process.env.BYOMEM_RUNTIME_BASE_DIR,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderrBytes = 0;
  let stdoutOversized = false;
  let stderrOversized = false;
  let settled = false;

  const finishFailure = (failure: FileSearchWorkerFailure) => failurePayload(request.toolName, failure);

  return new Promise((resolvePromise) => {
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolvePromise(finishFailure({
        kind: 'worker_failure',
        exitCode: null,
        signal: 'SIGKILL',
        timeoutMs: config.timeoutMs,
        memoryLimitMb: config.memoryLimitMb,
        retryable: true,
        recoveryHint: 'Retry the file-search operation or lower file-search worker memory pressure.',
        reason: 'timeout',
      }));
    }, config.timeoutMs);
    timeout.unref?.();

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length + chunk.length > FILE_SEARCH_WORKER_STDIO_MAX_BYTES) {
        stdoutOversized = true;
        child.kill('SIGKILL');
        return;
      }
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > FILE_SEARCH_WORKER_STDIO_MAX_BYTES) {
        stderrOversized = true;
        child.kill('SIGKILL');
      }
    });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise(finishFailure({
        kind: 'worker_failure',
        exitCode: null,
        signal: null,
        memoryLimitMb: config.memoryLimitMb,
        retryable: true,
        recoveryHint: 'Verify the file-search worker entrypoint exists and retry.',
        reason: 'spawn-error',
      }));
    });
    child.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (stdoutOversized || stderrOversized) {
        resolvePromise(finishFailure({
          kind: 'worker_failure',
          exitCode,
          signal,
          memoryLimitMb: config.memoryLimitMb,
          retryable: true,
          recoveryHint: 'Retry with a smaller request or inspect worker logs outside MCP.',
          reason: 'oversized-output',
        }));
        return;
      }
      if (exitCode !== 0 || signal) {
        resolvePromise(finishFailure({
          kind: 'worker_failure',
          exitCode,
          signal,
          memoryLimitMb: config.memoryLimitMb,
          retryable: true,
          recoveryHint: 'Retry the file-search operation; the MCP parent process stayed alive.',
          reason: signal ? 'signal' : 'exit',
        }));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout.trim()));
      } catch {
        resolvePromise(finishFailure({
          kind: 'worker_failure',
          exitCode,
          signal,
          memoryLimitMb: config.memoryLimitMb,
          retryable: true,
          recoveryHint: 'Retry the file-search operation; worker returned malformed JSON.',
          reason: 'malformed-response',
        }));
      }
    });

    child.stdin?.end(`${JSON.stringify(request)}\n`);
  });
}

export async function callFileSearchWorker(request: FileSearchWorkerRequest): Promise<unknown> {
  const config = resolveFileSearchWorkerConfig();
  const rejected = await acquireWorkerSlot(config, request.toolName);
  if (rejected) return rejected;
  try {
    return await executeFileSearchWorker(request, config);
  } finally {
    releaseWorkerSlot();
  }
}
