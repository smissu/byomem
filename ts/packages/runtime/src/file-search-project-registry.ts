import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { basename, resolve } from 'node:path';
import { resolveFileSearchProjectKey, type FileSearchScannerProgress } from './file-search-db.js';

export type FileSearchProjectState = 'seen' | 'enabled' | 'disabled';
export type FileSearchProjectSource = 'manual-register' | 'manual-unregister' | 'manual-scan' | 'manual-search' | 'manual-status';
export type FileSearchPollingDisabledReason =
  | 'default-off'
  | 'no-active-project'
  | 'not-active-project'
  | 'idle-no-changes'
  | 'manually-disabled'
  | 'session-ended'
  | 'project-disabled'
  | 'unregistered-project'
  | 'poll-error';

const FILE_SEARCH_POLLING_DISABLED_REASONS = new Set<FileSearchPollingDisabledReason>([
  'default-off',
  'no-active-project',
  'not-active-project',
  'idle-no-changes',
  'manually-disabled',
  'session-ended',
  'project-disabled',
  'unregistered-project',
  'poll-error',
]);

export function normalizeFileSearchPollingDisabledReason(value: string): FileSearchPollingDisabledReason {
  if (FILE_SEARCH_POLLING_DISABLED_REASONS.has(value as FileSearchPollingDisabledReason)) return value as FileSearchPollingDisabledReason;
  throw new Error(`Invalid file-search polling disabled reason: ${value}`);
}

export interface FileSearchProjectEntry {
  projectKey: string;
  baseDir: string;
  displayName: string;
  state: FileSearchProjectState;
  source: FileSearchProjectSource;
  pollIntervalSeconds?: number;
  pollingEnabled: boolean;
  lastPollAt?: string;
  nextPollAt?: string;
  consecutiveNoChangePolls: number;
  idleDisableAfterPolls?: number;
  pollingDisabledReason?: FileSearchPollingDisabledReason;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
  registeredAt?: string;
  lastScanAt?: string;
  lastError?: string;
}

interface FileSearchProjectRow {
  project_key: string;
  base_dir: string;
  display_name: string;
  state: FileSearchProjectState;
  source: FileSearchProjectSource;
  poll_interval_seconds: number | null;
  polling_enabled?: number | null;
  last_poll_at?: string | null;
  next_poll_at?: string | null;
  consecutive_no_change_polls?: number | null;
  idle_disable_after_polls?: number | null;
  polling_disabled_reason?: FileSearchPollingDisabledReason | null;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
  registered_at: string | null;
  last_scan_at: string | null;
  last_error: string | null;
}

export interface FileSearchPollingStatusDto {
  project_key: string;
  base_dir: string;
  display_name: string;
  polling_enabled: boolean;
  poll_interval_seconds: number | null;
  last_poll_at: string | null;
  next_poll_at: string | null;
  consecutive_no_change_polls: number;
  idle_disable_after_polls: number | null;
  polling_disabled_reason: FileSearchPollingDisabledReason | null;
  last_scan_at: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function canonicalBaseDir(baseDir: string): string {
  const trimmed = baseDir.trim();
  if (!trimmed) throw new Error('file-search project baseDir is required');
  return resolve(trimmed);
}

function displayNameFor(baseDir: string): string {
  return basename(baseDir) || baseDir;
}

function boolFromSqlite(value: number | null | undefined): boolean {
  return value === 1;
}

function toEntry(row: FileSearchProjectRow): FileSearchProjectEntry {
  const pollingEnabled = boolFromSqlite(row.polling_enabled);
  return {
    projectKey: row.project_key,
    baseDir: row.base_dir,
    displayName: row.display_name,
    state: row.state,
    source: row.source,
    pollIntervalSeconds: row.poll_interval_seconds ?? undefined,
    pollingEnabled,
    lastPollAt: row.last_poll_at ?? undefined,
    nextPollAt: row.next_poll_at ?? undefined,
    consecutiveNoChangePolls: row.consecutive_no_change_polls ?? 0,
    idleDisableAfterPolls: row.idle_disable_after_polls ?? undefined,
    pollingDisabledReason: row.polling_disabled_reason ?? (pollingEnabled ? undefined : 'default-off'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
    registeredAt: row.registered_at ?? undefined,
    lastScanAt: row.last_scan_at ?? undefined,
    lastError: row.last_error ?? undefined,
  } as FileSearchProjectEntry;
}

function ensureColumn(db: BetterSqliteDatabase, column: string, definition: string): void {
  const rows = db.prepare('PRAGMA table_info(file_search_projects)').all() as Array<{ name: string }>;
  if (!rows.some((row) => row.name === column)) db.exec(`ALTER TABLE file_search_projects ADD COLUMN ${definition}`);
}

export function ensureFileSearchProjectRegistrySchema(db: BetterSqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_search_projects (
      project_key TEXT PRIMARY KEY,
      base_dir TEXT NOT NULL,
      display_name TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('seen', 'enabled', 'disabled')),
      source TEXT NOT NULL CHECK (source IN ('manual-register', 'manual-unregister', 'manual-scan', 'manual-search', 'manual-status')),
      poll_interval_seconds INTEGER,
      polling_enabled INTEGER NOT NULL DEFAULT 0,
      last_poll_at TEXT,
      next_poll_at TEXT,
      consecutive_no_change_polls INTEGER NOT NULL DEFAULT 0,
      idle_disable_after_polls INTEGER,
      polling_disabled_reason TEXT DEFAULT 'default-off',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      registered_at TEXT,
      last_scan_at TEXT,
      last_error TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_file_search_projects_base_dir ON file_search_projects(base_dir);
    CREATE INDEX IF NOT EXISTS idx_file_search_projects_state ON file_search_projects(state);
  `);
  ensureColumn(db, 'polling_enabled', 'polling_enabled INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'last_poll_at', 'last_poll_at TEXT');
  ensureColumn(db, 'next_poll_at', 'next_poll_at TEXT');
  ensureColumn(db, 'consecutive_no_change_polls', 'consecutive_no_change_polls INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'idle_disable_after_polls', 'idle_disable_after_polls INTEGER');
  ensureColumn(db, 'polling_disabled_reason', "polling_disabled_reason TEXT DEFAULT 'default-off'");
  db.prepare("UPDATE file_search_projects SET polling_disabled_reason = 'default-off' WHERE polling_enabled = 0 AND polling_disabled_reason IS NULL").run();
  db.prepare('UPDATE file_search_projects SET consecutive_no_change_polls = 0 WHERE consecutive_no_change_polls IS NULL').run();
}

export function resolveFileSearchProjectRegistryIdentity(baseDir: string): { projectKey: string; baseDir: string; displayName: string } {
  const resolvedBaseDir = canonicalBaseDir(baseDir);
  return {
    projectKey: resolveFileSearchProjectKey(resolvedBaseDir),
    baseDir: resolvedBaseDir,
    displayName: displayNameFor(resolvedBaseDir),
  };
}

export function serializeFileSearchPollingStatus(entry: FileSearchProjectEntry): FileSearchPollingStatusDto {
  return {
    project_key: entry.projectKey,
    base_dir: entry.baseDir,
    display_name: entry.displayName,
    polling_enabled: entry.pollingEnabled,
    poll_interval_seconds: entry.pollIntervalSeconds ?? null,
    last_poll_at: entry.lastPollAt ?? null,
    next_poll_at: entry.nextPollAt ?? null,
    consecutive_no_change_polls: entry.consecutiveNoChangePolls,
    idle_disable_after_polls: entry.idleDisableAfterPolls ?? null,
    polling_disabled_reason: entry.pollingDisabledReason ?? null,
    last_scan_at: entry.lastScanAt ?? null,
  };
}

export function listFileSearchProjects(db: BetterSqliteDatabase): FileSearchProjectEntry[] {
  ensureFileSearchProjectRegistrySchema(db);
  const rows = db.prepare('SELECT * FROM file_search_projects ORDER BY base_dir ASC').all() as FileSearchProjectRow[];
  return rows.map(toEntry);
}

export function getFileSearchProject(db: BetterSqliteDatabase, baseDir: string): FileSearchProjectEntry | undefined {
  ensureFileSearchProjectRegistrySchema(db);
  const identity = resolveFileSearchProjectRegistryIdentity(baseDir);
  const row = db.prepare('SELECT * FROM file_search_projects WHERE project_key = ? OR base_dir = ?').get(identity.projectKey, identity.baseDir) as FileSearchProjectRow | undefined;
  return row ? toEntry(row) : undefined;
}

function ensureFileSearchProject(db: BetterSqliteDatabase, baseDir: string, source: FileSearchProjectSource = 'manual-status'): FileSearchProjectEntry {
  ensureFileSearchProjectRegistrySchema(db);
  const identity = resolveFileSearchProjectRegistryIdentity(baseDir);
  const current = getFileSearchProject(db, identity.baseDir);
  if (current) return current;
  const now = nowIso();
  db.prepare(`INSERT INTO file_search_projects
    (project_key, base_dir, display_name, state, source, poll_interval_seconds, polling_enabled, last_poll_at, next_poll_at, consecutive_no_change_polls, idle_disable_after_polls, polling_disabled_reason, created_at, updated_at, last_seen_at, registered_at, last_scan_at, last_error)
    VALUES (?, ?, ?, 'seen', ?, NULL, 0, NULL, NULL, 0, NULL, 'default-off', ?, ?, ?, NULL, NULL, NULL)`).run(
    identity.projectKey,
    identity.baseDir,
    identity.displayName,
    source,
    now,
    now,
    now,
  );
  return getFileSearchProject(db, identity.baseDir)!;
}

export function markFileSearchProjectSeen(db: BetterSqliteDatabase, baseDir: string, source: Extract<FileSearchProjectSource, 'manual-scan' | 'manual-search' | 'manual-status'>): FileSearchProjectEntry {
  const current = ensureFileSearchProject(db, baseDir, source);
  const identity = resolveFileSearchProjectRegistryIdentity(baseDir);
  if (
    source === 'manual-search'
    && current.baseDir === identity.baseDir
    && current.displayName === identity.displayName
    && current.source === source
    && !current.lastError
  ) {
    return current;
  }
  const now = nowIso();
  const lastScanAt = source === 'manual-scan' ? now : (current.lastScanAt ?? null);
  db.prepare(`UPDATE file_search_projects SET
      base_dir = ?,
      display_name = ?,
      state = ?,
      source = ?,
      updated_at = ?,
      last_seen_at = ?,
      registered_at = ?,
      last_scan_at = ?,
      last_error = NULL
    WHERE project_key = ?`).run(
    identity.baseDir,
    identity.displayName,
    current.state,
    source,
    now,
    now,
    current.registeredAt ?? null,
    lastScanAt,
    identity.projectKey,
  );
  return getFileSearchProject(db, identity.baseDir)!;
}

export function registerFileSearchProject(db: BetterSqliteDatabase, baseDir: string): FileSearchProjectEntry {
  const current = ensureFileSearchProject(db, baseDir, 'manual-register');
  const identity = resolveFileSearchProjectRegistryIdentity(baseDir);
  const now = nowIso();
  const registeredAt = current.registeredAt ?? now;
  db.prepare(`UPDATE file_search_projects SET
      base_dir = ?,
      display_name = ?,
      state = 'enabled',
      source = 'manual-register',
      updated_at = ?,
      last_seen_at = ?,
      registered_at = ?,
      last_error = NULL
    WHERE project_key = ?`).run(
    identity.baseDir,
    identity.displayName,
    now,
    now,
    registeredAt,
    identity.projectKey,
  );
  return getFileSearchProject(db, identity.baseDir)!;
}

export function unregisterFileSearchProject(db: BetterSqliteDatabase, baseDir: string): FileSearchProjectEntry {
  const current = ensureFileSearchProject(db, baseDir, 'manual-unregister');
  const identity = resolveFileSearchProjectRegistryIdentity(baseDir);
  const now = nowIso();
  db.prepare(`UPDATE file_search_projects SET
      base_dir = ?,
      display_name = ?,
      state = 'disabled',
      source = 'manual-unregister',
      polling_enabled = 0,
      next_poll_at = NULL,
      polling_disabled_reason = 'project-disabled',
      updated_at = ?,
      last_seen_at = ?,
      registered_at = ?,
      last_error = NULL
    WHERE project_key = ?`).run(
    identity.baseDir,
    identity.displayName,
    now,
    now,
    current.registeredAt ?? null,
    identity.projectKey,
  );
  return getFileSearchProject(db, identity.baseDir)!;
}

function validatePositiveInteger(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function getFileSearchProjectPollingStatus(db: BetterSqliteDatabase, baseDir: string): FileSearchProjectEntry {
  return ensureFileSearchProject(db, baseDir, 'manual-status');
}

export function enableFileSearchProjectPolling(db: BetterSqliteDatabase, baseDir: string, options: { pollIntervalSeconds: number; idleDisableAfterPolls?: number; nextPollAt?: string | null }): FileSearchProjectEntry {
  const current = ensureFileSearchProject(db, baseDir, 'manual-status');
  const identity = resolveFileSearchProjectRegistryIdentity(baseDir);
  const now = nowIso();
  const pollIntervalSeconds = validatePositiveInteger(options.pollIntervalSeconds, 'poll_interval_seconds')!;
  const idleDisableAfterPolls = validatePositiveInteger(options.idleDisableAfterPolls, 'idle_disable_after_polls');
  db.prepare(`UPDATE file_search_projects SET
      polling_enabled = 1,
      poll_interval_seconds = ?,
      idle_disable_after_polls = ?,
      consecutive_no_change_polls = 0,
      polling_disabled_reason = NULL,
      next_poll_at = ?,
      updated_at = ?,
      last_seen_at = ?,
      registered_at = ?,
      last_error = NULL
    WHERE project_key = ?`).run(
    pollIntervalSeconds,
    idleDisableAfterPolls ?? null,
    options.nextPollAt ?? null,
    now,
    now,
    current.registeredAt ?? null,
    identity.projectKey,
  );
  return getFileSearchProject(db, identity.baseDir)!;
}

export function disableFileSearchProjectPolling(db: BetterSqliteDatabase, baseDir: string, reason: FileSearchPollingDisabledReason = 'manually-disabled'): FileSearchProjectEntry {
  reason = normalizeFileSearchPollingDisabledReason(reason);
  ensureFileSearchProject(db, baseDir, 'manual-status');
  const identity = resolveFileSearchProjectRegistryIdentity(baseDir);
  const now = nowIso();
  db.prepare(`UPDATE file_search_projects SET
      polling_enabled = 0,
      next_poll_at = NULL,
      polling_disabled_reason = ?,
      updated_at = ?,
      last_seen_at = ?
    WHERE project_key = ?`).run(reason, now, now, identity.projectKey);
  return getFileSearchProject(db, identity.baseDir)!;
}

export function recordFileSearchPollAttempt(db: BetterSqliteDatabase, baseDir: string, options: { pollAt?: string; nextPollAt?: string | null }): FileSearchProjectEntry {
  ensureFileSearchProject(db, baseDir, 'manual-status');
  const identity = resolveFileSearchProjectRegistryIdentity(baseDir);
  const now = nowIso();
  const pollAt = options.pollAt ?? now;
  db.prepare(`UPDATE file_search_projects SET
      polling_enabled = 1,
      last_poll_at = ?,
      next_poll_at = ?,
      polling_disabled_reason = NULL,
      updated_at = ?,
      last_seen_at = ?
    WHERE project_key = ?`).run(pollAt, options.nextPollAt ?? null, now, now, identity.projectKey);
  return getFileSearchProject(db, identity.baseDir)!;
}

export function recordFileSearchPollSuccess(db: BetterSqliteDatabase, baseDir: string, progress: FileSearchScannerProgress, options: { completedAt?: string; nextPollAt?: string | null } = {}): FileSearchProjectEntry {
  const current = ensureFileSearchProject(db, baseDir, 'manual-status');
  const identity = resolveFileSearchProjectRegistryIdentity(baseDir);
  const now = nowIso();
  const completedAt = options.completedAt ?? now;
  const noChange = progress.changedFiles === 0 && progress.deletedFiles === 0 && progress.chunksWritten === 0;
  const consecutive = noChange ? current.consecutiveNoChangePolls + 1 : 0;
  const shouldIdleDisable = Boolean(current.idleDisableAfterPolls && consecutive >= current.idleDisableAfterPolls);
  db.prepare(`UPDATE file_search_projects SET
      polling_enabled = ?,
      next_poll_at = ?,
      consecutive_no_change_polls = ?,
      polling_disabled_reason = ?,
      last_scan_at = ?,
      updated_at = ?,
      last_seen_at = ?,
      last_error = NULL
    WHERE project_key = ?`).run(
    shouldIdleDisable ? 0 : 1,
    shouldIdleDisable ? null : (options.nextPollAt ?? null),
    consecutive,
    shouldIdleDisable ? 'idle-no-changes' : null,
    completedAt,
    now,
    now,
    identity.projectKey,
  );
  return getFileSearchProject(db, identity.baseDir)!;
}

export function recordFileSearchPollFailure(db: BetterSqliteDatabase, baseDir: string, error: unknown, _options: { nextPollAt?: string | null } = {}): FileSearchProjectEntry {
  ensureFileSearchProject(db, baseDir, 'manual-status');
  const identity = resolveFileSearchProjectRegistryIdentity(baseDir);
  const now = nowIso();
  const message = error instanceof Error ? error.message : String(error);
  db.prepare(`UPDATE file_search_projects SET
      polling_enabled = 0,
      next_poll_at = NULL,
      polling_disabled_reason = 'poll-error',
      updated_at = ?,
      last_seen_at = ?,
      last_error = ?
    WHERE project_key = ?`).run(now, now, message, identity.projectKey);
  return getFileSearchProject(db, identity.baseDir)!;
}
