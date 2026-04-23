import type { FileSearchDbHandle, FileSearchRefreshEvent } from './file-search-db.js';
import { resolveProjectContext } from './project-context.js';

export interface FileIndexSchedulerMetrics {
  runs: number;
  failures: number;
}

interface ProjectSchedulerState {
  lastActivationAt?: number;
  lastActivityAt?: number;
  lastRefreshAt?: number;
  pending?: FileSearchRefreshEvent;
  failed?: boolean;
}

export class FileIndexScheduler {
  private readonly projects = new Map<string, ProjectSchedulerState>();
  private readonly metrics: FileIndexSchedulerMetrics = { runs: 0, failures: 0 };
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

  get refreshMetrics(): FileIndexSchedulerMetrics {
    return this.metrics;
  }

  scheduleRefresh(event: FileSearchRefreshEvent): void {
    const projectKey = event.projectKey ?? this.defaultProjectKey;
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
    if (!state.pending) return;
    if (this.projects.size > this.maxActiveProjects && !this.projects.has(projectKey)) return;

    try {
      this.db.scanAndIndex();
      state.lastRefreshAt = Date.now();
      state.pending = undefined;
      state.failed = false;
      this.metrics.runs += 1;
    } catch {
      state.failed = true;
      this.metrics.failures += 1;
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
