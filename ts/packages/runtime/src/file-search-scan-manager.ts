import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FileSearchScannerStatus, FileSearchScannerTrigger } from './file-search-db.js';

export type FileSearchAsyncScanJobState = 'queued' | 'running' | 'completed' | 'failed';

export interface FileSearchAsyncScanRequest {
  projectKey: string;
  baseDir: string;
  trigger?: FileSearchScannerTrigger;
}

export interface FileSearchAsyncScanJob {
  job_id: string;
  project_key: string;
  base_dir: string;
  state: FileSearchAsyncScanJobState;
  trigger: FileSearchScannerTrigger;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  durable: false;
  scanner?: FileSearchScannerStatus;
}

export interface FileSearchAsyncScanJobStatus {
  found: boolean;
  runtime_local: true;
  durable: false;
  job: FileSearchAsyncScanJob | null;
  error: string | null;
}

type ScanRunner = (request: Required<FileSearchAsyncScanRequest>) => FileSearchScannerStatus | Promise<FileSearchScannerStatus>;
type StatusReader = (request: Required<FileSearchAsyncScanRequest>) => FileSearchScannerStatus | undefined;
type Scheduler = (callback: () => void) => void;

export interface FileSearchScanManagerOptions {
  scanRunner: ScanRunner;
  statusReader?: StatusReader;
  concurrency?: number;
  maxRecentJobs?: number;
  scheduler?: Scheduler;
}

const DEFAULT_CONCURRENCY = 1;
const DEFAULT_MAX_RECENT_JOBS = 100;

function defaultScheduler(callback: () => void): void {
  setTimeout(callback, 0);
}

function cloneJob(job: FileSearchAsyncScanJob): FileSearchAsyncScanJob {
  return { ...job, scanner: job.scanner ? { ...job.scanner, progress: { ...job.scanner.progress }, database: { ...job.scanner.database }, embeddings: job.scanner.embeddings ? { ...job.scanner.embeddings, actualDimensions: [...job.scanner.embeddings.actualDimensions] } : undefined } : undefined };
}

export class FileSearchScanManager {
  private readonly scanRunner: ScanRunner;
  private readonly statusReader?: StatusReader;
  private readonly concurrency: number;
  private readonly maxRecentJobs: number;
  private readonly scheduler: Scheduler;
  private readonly jobs = new Map<string, FileSearchAsyncScanJob>();
  private readonly activeByProject = new Map<string, string>();
  private readonly queue: string[] = [];
  private running = 0;
  private pumpScheduled = false;

  constructor(options: FileSearchScanManagerOptions) {
    this.scanRunner = options.scanRunner;
    this.statusReader = options.statusReader;
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY));
    this.maxRecentJobs = Math.max(1, Math.floor(options.maxRecentJobs ?? DEFAULT_MAX_RECENT_JOBS));
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  enqueueScan(request: FileSearchAsyncScanRequest): FileSearchAsyncScanJob {
    const trigger = request.trigger ?? 'manual';
    const baseDir = resolve(request.baseDir);
    const activeJobId = this.activeByProject.get(request.projectKey);
    if (activeJobId) {
      const active = this.jobs.get(activeJobId);
      if (active && (active.state === 'queued' || active.state === 'running')) return this.snapshotJob(active);
      this.activeByProject.delete(request.projectKey);
    }

    const job: FileSearchAsyncScanJob = {
      job_id: `runtime-scan-${randomUUID()}`,
      project_key: request.projectKey,
      base_dir: baseDir,
      state: 'queued',
      trigger,
      queued_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      error: null,
      durable: false,
    };
    this.jobs.set(job.job_id, job);
    this.activeByProject.set(job.project_key, job.job_id);
    this.queue.push(job.job_id);
    this.schedulePump();
    return this.snapshotJob(job);
  }

  getJob(jobId: string): FileSearchAsyncScanJob | undefined {
    const job = this.jobs.get(jobId);
    return job ? this.snapshotJob(job) : undefined;
  }

  getJobStatus(jobId: string): FileSearchAsyncScanJobStatus {
    const job = this.getJob(jobId);
    if (!job) {
      return {
        found: false,
        runtime_local: true,
        durable: false,
        job: null,
        error: 'runtime-local-job-not-found',
      };
    }
    return { found: true, runtime_local: true, durable: false, job, error: null };
  }

  getProjectActiveJob(projectKey: string): FileSearchAsyncScanJob | undefined {
    const jobId = this.activeByProject.get(projectKey);
    if (!jobId) return undefined;
    const job = this.jobs.get(jobId);
    return job ? this.snapshotJob(job) : undefined;
  }

  getProjectLatestJob(projectKey: string): FileSearchAsyncScanJob | undefined {
    const active = this.getProjectActiveJob(projectKey);
    if (active) return active;
    const jobs = [...this.jobs.values()].filter((job) => job.project_key === projectKey);
    const latest = jobs.at(-1);
    return latest ? this.snapshotJob(latest) : undefined;
  }

  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    this.scheduler(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const jobId = this.queue.shift();
      if (!jobId) continue;
      const job = this.jobs.get(jobId);
      if (!job || job.state !== 'queued') continue;
      this.running += 1;
      void this.runJob(job).finally(() => {
        this.running -= 1;
        this.pruneRecentJobs();
        if (this.queue.length > 0) this.schedulePump();
      });
    }
  }

  private async runJob(job: FileSearchAsyncScanJob): Promise<void> {
    job.state = 'running';
    job.started_at = new Date().toISOString();
    try {
      const scanner = await this.scanRunner({ projectKey: job.project_key, baseDir: job.base_dir, trigger: job.trigger });
      job.scanner = scanner;
      job.state = 'completed';
      job.completed_at = new Date().toISOString();
      job.error = null;
    } catch (error) {
      job.state = 'failed';
      job.completed_at = new Date().toISOString();
      job.error = error instanceof Error ? error.message : String(error);
      job.scanner = this.readScannerStatus(job);
    } finally {
      const activeJobId = this.activeByProject.get(job.project_key);
      if (activeJobId === job.job_id) this.activeByProject.delete(job.project_key);
    }
  }

  private snapshotJob(job: FileSearchAsyncScanJob): FileSearchAsyncScanJob {
    const snapshot = cloneJob(job);
    if (!snapshot.scanner) snapshot.scanner = this.readScannerStatus(job);
    return snapshot;
  }

  private readScannerStatus(job: FileSearchAsyncScanJob): FileSearchScannerStatus | undefined {
    if (!this.statusReader) return undefined;
    try {
      return this.statusReader({ projectKey: job.project_key, baseDir: job.base_dir, trigger: job.trigger });
    } catch {
      return undefined;
    }
  }

  private pruneRecentJobs(): void {
    if (this.jobs.size <= this.maxRecentJobs) return;
    for (const [jobId, job] of this.jobs) {
      if (this.jobs.size <= this.maxRecentJobs) return;
      if (job.state === 'queued' || job.state === 'running') continue;
      this.jobs.delete(jobId);
    }
  }
}
