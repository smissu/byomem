import { describe, expect, it } from 'vitest';
import { FILE_SEARCH_WORKER_DEFAULT_MAX_CONCURRENCY, FILE_SEARCH_WORKER_DEFAULT_MAX_OLD_SPACE_MB, FILE_SEARCH_WORKER_DEFAULT_QUEUE_DEPTH, FILE_SEARCH_WORKER_DEFAULT_TIMEOUT_MS, resolveFileSearchWorkerConfig } from '../src/file-search-worker-runner.js';

describe('Sprint 70 file-search worker contracts', () => {
  it('defines bounded worker defaults and environment override names', () => {
    const originalTimeout = process.env.BYOMEM_FILE_SEARCH_WORKER_TIMEOUT_MS;
    const originalMemory = process.env.BYOMEM_FILE_SEARCH_WORKER_MAX_OLD_SPACE_MB;
    const originalMaxConcurrency = process.env.BYOMEM_FILE_SEARCH_WORKER_MAX_CONCURRENCY;
    const originalQueueDepth = process.env.BYOMEM_FILE_SEARCH_WORKER_QUEUE_DEPTH;
    try {
      delete process.env.BYOMEM_FILE_SEARCH_WORKER_TIMEOUT_MS;
      delete process.env.BYOMEM_FILE_SEARCH_WORKER_MAX_OLD_SPACE_MB;
      delete process.env.BYOMEM_FILE_SEARCH_WORKER_MAX_CONCURRENCY;
      delete process.env.BYOMEM_FILE_SEARCH_WORKER_QUEUE_DEPTH;
      expect(resolveFileSearchWorkerConfig()).toMatchObject({
        timeoutMs: FILE_SEARCH_WORKER_DEFAULT_TIMEOUT_MS,
        memoryLimitMb: FILE_SEARCH_WORKER_DEFAULT_MAX_OLD_SPACE_MB,
        maxConcurrency: FILE_SEARCH_WORKER_DEFAULT_MAX_CONCURRENCY,
        queueDepth: FILE_SEARCH_WORKER_DEFAULT_QUEUE_DEPTH,
      });

      process.env.BYOMEM_FILE_SEARCH_WORKER_TIMEOUT_MS = '1234';
      process.env.BYOMEM_FILE_SEARCH_WORKER_MAX_OLD_SPACE_MB = '96';
      process.env.BYOMEM_FILE_SEARCH_WORKER_MAX_CONCURRENCY = '2';
      process.env.BYOMEM_FILE_SEARCH_WORKER_QUEUE_DEPTH = '0';
      expect(resolveFileSearchWorkerConfig()).toMatchObject({
        timeoutMs: 1234,
        memoryLimitMb: 96,
        maxConcurrency: 2,
        queueDepth: 0,
      });
    } finally {
      if (originalTimeout === undefined) delete process.env.BYOMEM_FILE_SEARCH_WORKER_TIMEOUT_MS;
      else process.env.BYOMEM_FILE_SEARCH_WORKER_TIMEOUT_MS = originalTimeout;
      if (originalMemory === undefined) delete process.env.BYOMEM_FILE_SEARCH_WORKER_MAX_OLD_SPACE_MB;
      else process.env.BYOMEM_FILE_SEARCH_WORKER_MAX_OLD_SPACE_MB = originalMemory;
      if (originalMaxConcurrency === undefined) delete process.env.BYOMEM_FILE_SEARCH_WORKER_MAX_CONCURRENCY;
      else process.env.BYOMEM_FILE_SEARCH_WORKER_MAX_CONCURRENCY = originalMaxConcurrency;
      if (originalQueueDepth === undefined) delete process.env.BYOMEM_FILE_SEARCH_WORKER_QUEUE_DEPTH;
      else process.env.BYOMEM_FILE_SEARCH_WORKER_QUEUE_DEPTH = originalQueueDepth;
    }
  });
});
