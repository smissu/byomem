import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { QueueEvent } from './contracts.js';

export interface QueueJob {
  jobId: string;
  sessionId: string;
  workerId: string;
  offset: number;
  event: QueueEvent;
  state: 'queued' | 'checkpointed' | 'flushed';
}

export interface QueueSnapshot {
  version: 1;
  jobs: QueueJob[];
}

export interface QueueOptions {
  baseDir: string;
  queueFile?: string;
}

function loadQueueSnapshot(filePath: string): QueueSnapshot {
  if (!existsSync(filePath)) return { version: 1, jobs: [] };
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { jobs?: unknown }).jobs)) {
    throw new Error('Invalid queue snapshot');
  }
  return parsed as QueueSnapshot;
}

function persistQueueSnapshot(filePath: string, snapshot: QueueSnapshot): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  renameSync(tempPath, filePath);
}

export interface NativeQueue {
  enqueue(event: QueueEvent, workerId: string, offset: number): QueueJob;
  checkpoint(jobId: string): QueueJob | undefined;
  flush(jobId: string): QueueJob | undefined;
  list(): QueueJob[];
}

export function openNativeQueue(options: QueueOptions): NativeQueue {
  const filePath = resolve(options.baseDir, options.queueFile ?? 'queue.json');
  const snapshot = loadQueueSnapshot(filePath);
  const jobsById = new Map<string, QueueJob>(snapshot.jobs.map((job) => [job.jobId, job]));

  const persist = () => persistQueueSnapshot(filePath, { version: 1, jobs: [...jobsById.values()] });

  return {
    enqueue(event: QueueEvent, workerId: string, offset: number): QueueJob {
      const job: QueueJob = {
        jobId: event.eventId,
        sessionId: event.sessionId,
        workerId,
        offset,
        event,
        state: 'queued',
      };
      jobsById.set(job.jobId, job);
      persist();
      return job;
    },
    checkpoint(jobId: string): QueueJob | undefined {
      const job = jobsById.get(jobId);
      if (!job) return undefined;
      const updated = { ...job, state: 'checkpointed' as const };
      jobsById.set(jobId, updated);
      persist();
      return updated;
    },
    flush(jobId: string): QueueJob | undefined {
      const job = jobsById.get(jobId);
      if (!job) return undefined;
      const updated = { ...job, state: 'flushed' as const };
      jobsById.set(jobId, updated);
      persist();
      return updated;
    },
    list(): QueueJob[] {
      return [...jobsById.values()];
    },
  };
}
