import { resolve } from 'node:path';
import { disableFileSearchProjectPolling, enableFileSearchProjectPolling, getFileSearchProjectPollingStatus, recordFileSearchPollAttempt, recordFileSearchPollFailure, recordFileSearchPollSuccess, serializeFileSearchPollingStatus, type FileSearchPollingDisabledReason, type FileSearchPollingStatusDto } from './file-search-project-registry.js';
import { openFileSearchDb, openFileSearchRegistryDb, type FileSearchDbOptions } from './file-search-db.js';
import type { FileSearchIndexStorageMode } from './file-search-semble.js';

export interface FileSearchActivePollerOptions {
  baseDir: string;
  pollIntervalSeconds: number;
  idleDisableAfterPolls?: number;
  dbBaseDir?: string;
  embeddingBaseUrl?: string;
  embeddingModel?: string;
  embeddingDimension?: number;
  embeddingTimeoutMs?: number;
  embeddingRequireRemote?: boolean;
  semanticSearchEnabled?: boolean;
  scannerExcludedExtensions?: string[];
  scannerBinaryDetectionEnabled?: boolean;
  scannerIncludeTextFiles?: boolean;
  storageMode?: FileSearchIndexStorageMode;
}

function validatePositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function plusSecondsIso(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

export function getFileSearchPollingStatus(baseDir: string, options: Pick<FileSearchDbOptions, 'dbBaseDir'> = {}): FileSearchPollingStatusDto {
  const registry = openFileSearchRegistryDb({ dbBaseDir: options.dbBaseDir });
  try {
    return serializeFileSearchPollingStatus(getFileSearchProjectPollingStatus(registry.db, baseDir));
  } finally {
    registry.close();
  }
}

export function configureFileSearchPolling(baseDir: string, options: { pollIntervalSeconds: number; idleDisableAfterPolls?: number; dbBaseDir?: string; nextPollAt?: string | null }): FileSearchPollingStatusDto {
  const pollIntervalSeconds = validatePositiveInteger(options.pollIntervalSeconds, 'poll_interval_seconds');
  const idleDisableAfterPolls = options.idleDisableAfterPolls === undefined ? undefined : validatePositiveInteger(options.idleDisableAfterPolls, 'idle_disable_after_polls');
  const registry = openFileSearchRegistryDb({ dbBaseDir: options.dbBaseDir });
  try {
    const entry = enableFileSearchProjectPolling(registry.db, baseDir, { pollIntervalSeconds, idleDisableAfterPolls, nextPollAt: options.nextPollAt ?? plusSecondsIso(pollIntervalSeconds) });
    return serializeFileSearchPollingStatus(entry);
  } finally {
    registry.close();
  }
}

export function disableFileSearchPolling(baseDir: string, reason: FileSearchPollingDisabledReason = 'manually-disabled', options: Pick<FileSearchDbOptions, 'dbBaseDir'> = {}): FileSearchPollingStatusDto {
  const registry = openFileSearchRegistryDb({ dbBaseDir: options.dbBaseDir });
  try {
    return serializeFileSearchPollingStatus(disableFileSearchProjectPolling(registry.db, baseDir, reason));
  } finally {
    registry.close();
  }
}

export class FileSearchActivePoller {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private readonly baseDir: string;
  private readonly pollIntervalSeconds: number;
  private readonly idleDisableAfterPolls?: number;

  constructor(private readonly options: FileSearchActivePollerOptions) {
    this.baseDir = resolve(options.baseDir);
    this.pollIntervalSeconds = validatePositiveInteger(options.pollIntervalSeconds, 'poll_interval_seconds');
    this.idleDisableAfterPolls = options.idleDisableAfterPolls === undefined ? undefined : validatePositiveInteger(options.idleDisableAfterPolls, 'idle_disable_after_polls');
  }

  start(): FileSearchPollingStatusDto {
    this.clearTimer();
    const nextPollAt = plusSecondsIso(this.pollIntervalSeconds);
    const status = configureFileSearchPolling(this.baseDir, {
      pollIntervalSeconds: this.pollIntervalSeconds,
      idleDisableAfterPolls: this.idleDisableAfterPolls,
      dbBaseDir: this.options.dbBaseDir,
      nextPollAt,
    });
    try {
      this.runBaselineScan();
    } catch (error) {
      disableFileSearchPolling(this.baseDir, 'poll-error', { dbBaseDir: this.options.dbBaseDir });
      throw error;
    }
    this.timer = setInterval(() => this.tick(), this.pollIntervalSeconds * 1000);
    return status;
  }

  status(): FileSearchPollingStatusDto {
    return getFileSearchPollingStatus(this.baseDir, { dbBaseDir: this.options.dbBaseDir });
  }

  stop(reason: FileSearchPollingDisabledReason = 'manually-disabled'): FileSearchPollingStatusDto {
    this.clearTimer();
    return disableFileSearchPolling(this.baseDir, reason, { dbBaseDir: this.options.dbBaseDir });
  }

  close(reason: FileSearchPollingDisabledReason = 'session-ended'): FileSearchPollingStatusDto {
    return this.stop(reason);
  }

  private clearTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private openDb() {
    return openFileSearchDb({
      baseDir: this.baseDir,
      projectBaseDir: this.baseDir,
      dbBaseDir: this.options.dbBaseDir,
      embeddingBaseUrl: this.options.embeddingBaseUrl,
      embeddingModel: this.options.embeddingModel,
      embeddingDimension: this.options.embeddingDimension,
      embeddingTimeoutMs: this.options.embeddingTimeoutMs,
      embeddingRequireRemote: this.options.embeddingRequireRemote,
      semanticSearchEnabled: this.options.semanticSearchEnabled,
      scanOnOpen: false,
      schedulerEnabled: false,
      scannerExcludedExtensions: this.options.scannerExcludedExtensions,
      scannerBinaryDetectionEnabled: this.options.scannerBinaryDetectionEnabled,
      scannerIncludeTextFiles: this.options.scannerIncludeTextFiles,
      storageMode: this.options.storageMode,
    });
  }

  private runBaselineScan(): void {
    const db = this.openDb();
    try {
      db.scanAndIndex({ trigger: 'manual' });
    } finally {
      db.close();
    }
  }

  private tick(): void {
    if (this.running) return;
    this.running = true;
    const pollAt = new Date().toISOString();
    const nextPollAt = plusSecondsIso(this.pollIntervalSeconds);
    const db = this.openDb();
    try {
      recordFileSearchPollAttempt(db.db, this.baseDir, { pollAt, nextPollAt });
      const status = db.scanAndIndex({ trigger: 'poll' });
      const entry = recordFileSearchPollSuccess(db.db, this.baseDir, status.progress, { completedAt: status.completedAt ?? new Date().toISOString(), nextPollAt });
      if (!entry.pollingEnabled) this.clearTimer();
    } catch (error) {
      recordFileSearchPollFailure(db.db, this.baseDir, error, { nextPollAt });
      this.clearTimer();
    } finally {
      db.close();
      this.running = false;
    }
  }
}
