import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface QueueJob {
  jobId: string;
  sessionId: string;
  workerId: string;
  offset: number;
  state: 'queued' | 'checkpointed' | 'flushed';
  event?: {
    eventId?: string;
    sessionId?: string;
    recordId?: string;
    kind?: string;
    createdAt?: string;
    payload?: { offset?: number };
  };
  writeIntent?: unknown;
}

export interface QueueSummary {
  totalJobs: number;
  states: { queued: number; checkpointed: number; flushed: number };
}

export interface WorkerSnapshot {
  workerId: string;
  sessionId: string;
  offset: number;
  lock: string | null;
}

export interface RecentJob {
  jobId: string;
  state: string;
  sessionId: string;
  workerId: string;
  offset: number;
  recordId?: string;
  kind?: string;
  identity?: string;
  contentSnippet?: string;
  createdAt?: string;
}

export interface ObserverHealth {
  status: 'idle' | 'active' | 'stale';
  hints: string[];
}

export interface QueueObserverSnapshot {
  format: 'json' | 'text';
  worker: WorkerSnapshot;
  queue: QueueSummary;
  recentJobs: RecentJob[];
  health: ObserverHealth;
  history: number;
}

export interface QueueObserverOptions {
  baseDir: string;
  history: number;
  json: boolean;
}

interface QueueSnapshotFile {
  version?: number;
  jobs?: QueueJob[];
}

interface WorkerSnapshotFile {
  version?: number;
  state?: WorkerSnapshot;
}

function clampHistory(history: number): number {
  if (!Number.isFinite(history) || Number.isNaN(history)) return 5;
  return Math.max(0, Math.min(100, Math.floor(history)));
}

function loadQueueJobs(baseDir: string): QueueJob[] {
  const filePath = resolve(baseDir, 'queue.json');
  if (!existsSync(filePath)) return [];
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as QueueSnapshotFile;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.jobs)) throw new Error('Invalid queue snapshot');
  return parsed.jobs as QueueJob[];
}

const EMPTY_WORKER: WorkerSnapshot = { workerId: '', sessionId: '', offset: 0, lock: null };

function isWorkerSnapshot(value: unknown): value is WorkerSnapshot {
  return !!value && typeof value === 'object'
    && typeof (value as WorkerSnapshot).workerId === 'string'
    && typeof (value as WorkerSnapshot).sessionId === 'string'
    && typeof (value as WorkerSnapshot).offset === 'number'
    && ((value as WorkerSnapshot).lock === null || typeof (value as WorkerSnapshot).lock === 'string');
}

function loadWorker(baseDir: string): WorkerSnapshot {
  const filePath = resolve(baseDir, 'worker.json');
  if (!existsSync(filePath)) return EMPTY_WORKER;
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as WorkerSnapshotFile;
  if (!parsed || typeof parsed !== 'object' || !isWorkerSnapshot(parsed.state)) return EMPTY_WORKER;
  return parsed.state;
}

function formatIdentity(job: QueueJob): string | undefined {
  const identity = (job.writeIntent as { identity?: { namespace?: string; parentContext?: string; leafName?: string } } | undefined)?.identity;
  if (!identity?.namespace && !identity?.parentContext && !identity?.leafName) return undefined;
  return [identity.namespace, identity.parentContext, identity.leafName].filter(Boolean).join('/');
}

function snippet(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined;
  const cleaned = text.trim().replace(/\s+/g, ' ');
  return cleaned.length > 60 ? `${cleaned.slice(0, 57)}…` : cleaned;
}

function recentJobs(jobs: QueueJob[], history: number): RecentJob[] {
  return jobs
    .slice()
    .sort((a, b) => {
      const aCreatedAt = a.event?.createdAt ?? '';
      const bCreatedAt = b.event?.createdAt ?? '';
      if (aCreatedAt !== bCreatedAt) return bCreatedAt.localeCompare(aCreatedAt);
      const aOffset = Number(a.offset ?? a.event?.payload?.offset ?? 0);
      const bOffset = Number(b.offset ?? b.event?.payload?.offset ?? 0);
      return bOffset - aOffset;
    })
    .slice(0, history)
    .map((job) => ({
      jobId: job.jobId,
      state: job.state,
      sessionId: job.sessionId,
      workerId: job.workerId,
      offset: Number(job.offset ?? job.event?.payload?.offset ?? 0),
      recordId: job.event?.recordId,
      kind: job.event?.kind,
      identity: formatIdentity(job),
      contentSnippet: snippet((job.writeIntent as { content?: { text?: unknown } } | undefined)?.content?.text),
      createdAt: job.event?.createdAt,
    }));
}

function summarize(jobs: QueueJob[]): QueueSummary {
  return jobs.reduce<QueueSummary>(
    (acc, job) => {
      acc.totalJobs += 1;
      acc.states[job.state] += 1;
      return acc;
    },
    { totalJobs: 0, states: { queued: 0, checkpointed: 0, flushed: 0 } },
  );
}

function health(worker: WorkerSnapshot, queue: QueueSummary): ObserverHealth {
  if (queue.totalJobs === 0) return { status: 'idle', hints: ['missing runtime state handled gracefully'] };
  const hints = [`worker ${worker.workerId}`, `offset ${worker.offset}`, `jobs ${queue.totalJobs}`];
  return { status: worker.lock ? 'active' : 'stale', hints };
}

export function observeQueue(options: QueueObserverOptions): QueueObserverSnapshot {
  const history = clampHistory(options.history);
  const jobs = loadQueueJobs(options.baseDir);
  const worker = loadWorker(options.baseDir);
  const queue = summarize(jobs);
  return {
    format: options.json ? 'json' : 'text',
    worker,
    queue,
    recentJobs: recentJobs(jobs, history),
    health: health(worker, queue),
    history,
  };
}

export function renderQueueObserver(snapshot: QueueObserverSnapshot): string {
  const lines = [
    'Worker',
    `  workerId: ${snapshot.worker.workerId}`,
    `  sessionId: ${snapshot.worker.sessionId || '(empty)'}`,
    `  offset: ${snapshot.worker.offset}`,
    `  lock: ${snapshot.worker.lock ?? '(none)'}`,
    'Queue Summary',
    `  totalJobs: ${snapshot.queue.totalJobs}`,
    `  queued: ${snapshot.queue.states.queued}`,
    `  checkpointed: ${snapshot.queue.states.checkpointed}`,
    `  flushed: ${snapshot.queue.states.flushed}`,
    'Health',
    `  status: ${snapshot.health.status}`,
    ...snapshot.health.hints.map((hint) => `  - ${hint}`),
    `Recent Jobs (${snapshot.history})`,
    ...snapshot.recentJobs.map((job) => `  - ${job.recordId ?? job.identity ?? job.jobId}${job.createdAt ? ` @ ${job.createdAt}` : ''}`),
  ];
  return lines.join('\n');
}
