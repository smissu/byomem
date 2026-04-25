import type { FileSearchDbHandle, FileSearchRefreshEvent } from './file-search-db.js';
import { resolveProjectContext } from './project-context.js';

export interface FileIndexSchedulerMetrics {
  runs: number;
  failures: number;
  skips: number;
  retries: number;
  lastRunAt?: string;
  lastFailureAt?: string;
}

export interface FileIndexSchedulerRefreshState extends FileIndexSchedulerMetrics {}

interface ProjectSchedulerState {
  lastActivationAt?: number;
  lastActivityAt?: number;
  lastRefreshAt?: number;
  pending?: FileSearchRefreshEvent;
  failed?: boolean;
  retryCount?: number;
}

export class FileIndexScheduler {
  private readonly projects = new Map<string, ProjectSchedulerState>();
  private readonly metrics: FileIndexSchedulerMetrics = { runs: 0, failures: 0, skips: 0, retries: 0 };
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private backstopTimer: ReturnType<typeof setInterval> | undefined;
  private readonly maxActiveProjects: number;
  private readonly debounceWindowMs: number;
  private readonly backstopWindowMs: number;
  private readonly defaultProjectKey: string;

  constructor(private readonly db: FileSearchDbHandle, private readonly baseDir: string, options?: { maxActiveProjects?: number; debounceWindowMs?: number; backstopWindowMs?: number }) {
    this.maxActiveProjects = options?.maxActiveProjects ?? 3;
    this.debounceWindowMs = options?.debounceWindowMs ?? 250;
    this.backstopWindowMs = options?.backstopWindowMs ?? 60_000;
    this.defaultProjectKey = `project:${resolveProjectContext({}, this.baseDir).projectKey}`;
    this.projects.set(this.defaultProjectKey, { lastRefreshAt: 0 });
    this.backstopTimer = setInterval(() => this.flushBackstop(), this.backstopWindowMs);
  }

  get refreshMetrics(): FileIndexSchedulerRefreshState {
    return this.metrics;
  }

  scheduleRefresh(event: FileSearchRefreshEvent): void {
    // A scheduler instance owns one FileSearchDbHandle/baseDir, so scan work is always
    // scoped to the default project for that handle. External projectKey values are
    // intentionally not treated as alternate scan targets.
    const projectKey = this.defaultProjectKey;
    if (!this.projects.has(projectKey) && this.projects.size >= this.maxActiveProjects) {
      this.metrics.skips += 1;
      return;
    }
    const state = this.ensureState(projectKey);
    const now = Date.now();

    if (event.kind === 'activation') state.lastActivationAt = now;
    if (event.kind === 'post-activity') state.lastActivityAt = now;
    if (event.kind === 'backstop') state.lastRefreshAt = state.lastRefreshAt ?? 0;
    state.pending = { ...event, projectKey };

    if (event.kind === 'activation') {
      this.flushProject(projectKey);
      return;
    }

    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flushScheduledRefreshes(), this.debounceWindowMs);
  }

  flushScheduledRefreshes(): void {
    const pending = [...this.projects.entries()].filter(([, state]) => state.pending);
    for (const [projectKey] of pending) this.flushProject(projectKey);
  }

  private flushBackstop(): void {
    for (const [projectKey, state] of this.projects.entries()) {
      const stale = !state.lastRefreshAt || Date.now() - state.lastRefreshAt >= this.backstopWindowMs;
      if (!stale) continue;
      state.pending = { kind: 'backstop', projectKey };
      this.flushProject(projectKey);
    }
  }

  private flushProject(projectKey: string): void {
    const state = this.ensureState(projectKey);
    if (!state.pending) {
      this.metrics.skips += 1;
      return;
    }

    try {
      this.db.scanAndIndex({ trigger: `scheduler-${state.pending.kind}` as 'scheduler-activation' | 'scheduler-post-activity' | 'scheduler-backstop' });
      const now = new Date();
      state.lastRefreshAt = now.getTime();
      state.pending = undefined;
      state.failed = false;
      state.retryCount = 0;
      this.metrics.runs += 1;
      this.metrics.lastRunAt = now.toISOString();
    } catch {
      const now = new Date();
      state.failed = true;
      state.retryCount = (state.retryCount ?? 0) + 1;
      this.metrics.failures += 1;
      this.metrics.retries += 1;
      this.metrics.lastFailureAt = now.toISOString();
      state.pending = undefined;
    }
  }

  private ensureState(projectKey: string): ProjectSchedulerState {
    const existing = this.projects.get(projectKey);
    if (existing) return existing;
    const state: ProjectSchedulerState = {};
    this.projects.set(projectKey, state);
    return state;
  }

  close(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.backstopTimer) clearInterval(this.backstopTimer);
  }
}
