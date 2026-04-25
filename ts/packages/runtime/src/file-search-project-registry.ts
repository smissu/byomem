import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { basename, resolve } from 'node:path';
import { resolveFileSearchProjectKey } from './file-search-db.js';

export type FileSearchProjectState = 'seen' | 'enabled' | 'disabled';
export type FileSearchProjectSource = 'manual-register' | 'manual-unregister' | 'manual-scan' | 'manual-search' | 'manual-status';

export interface FileSearchProjectEntry {
  projectKey: string;
  baseDir: string;
  displayName: string;
  state: FileSearchProjectState;
  source: FileSearchProjectSource;
  pollIntervalSeconds?: number;
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
  created_at: string;
  updated_at: string;
  last_seen_at: string;
  registered_at: string | null;
  last_scan_at: string | null;
  last_error: string | null;
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

function toEntry(row: FileSearchProjectRow): FileSearchProjectEntry {
  return {
    projectKey: row.project_key,
    baseDir: row.base_dir,
    displayName: row.display_name,
    state: row.state,
    source: row.source,
    pollIntervalSeconds: row.poll_interval_seconds ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
    registeredAt: row.registered_at ?? undefined,
    lastScanAt: row.last_scan_at ?? undefined,
    lastError: row.last_error ?? undefined,
  };
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
}

export function resolveFileSearchProjectRegistryIdentity(baseDir: string): { projectKey: string; baseDir: string; displayName: string } {
  const resolvedBaseDir = canonicalBaseDir(baseDir);
  return {
    projectKey: resolveFileSearchProjectKey(resolvedBaseDir),
    baseDir: resolvedBaseDir,
    displayName: displayNameFor(resolvedBaseDir),
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

export function markFileSearchProjectSeen(db: BetterSqliteDatabase, baseDir: string, source: Extract<FileSearchProjectSource, 'manual-scan' | 'manual-search' | 'manual-status'>): FileSearchProjectEntry {
  ensureFileSearchProjectRegistrySchema(db);
  const identity = resolveFileSearchProjectRegistryIdentity(baseDir);
  const current = getFileSearchProject(db, identity.baseDir);
  const now = nowIso();
  const state = current?.state ?? 'seen';
  const registeredAt = current?.registeredAt ?? null;
  const lastScanAt = source === 'manual-scan' ? now : (current?.lastScanAt ?? null);
  db.prepare(`INSERT INTO file_search_projects
    (project_key, base_dir, display_name, state, source, poll_interval_seconds, created_at, updated_at, last_seen_at, registered_at, last_scan_at, last_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_key) DO UPDATE SET
      base_dir = excluded.base_dir,
      display_name = excluded.display_name,
      state = ?,
      source = excluded.source,
      poll_interval_seconds = COALESCE(file_search_projects.poll_interval_seconds, excluded.poll_interval_seconds),
      updated_at = excluded.updated_at,
      last_seen_at = excluded.last_seen_at,
      registered_at = ?,
      last_scan_at = ?,
      last_error = NULL`).run(
    identity.projectKey,
    identity.baseDir,
    identity.displayName,
    state,
    source,
    current?.pollIntervalSeconds ?? null,
    current?.createdAt ?? now,
    now,
    now,
    registeredAt,
    lastScanAt,
    null,
    state,
    registeredAt,
    lastScanAt,
  );
  return getFileSearchProject(db, identity.baseDir)!;
}

export function registerFileSearchProject(db: BetterSqliteDatabase, baseDir: string): FileSearchProjectEntry {
  ensureFileSearchProjectRegistrySchema(db);
  const identity = resolveFileSearchProjectRegistryIdentity(baseDir);
  const current = getFileSearchProject(db, identity.baseDir);
  const now = nowIso();
  const registeredAt = current?.registeredAt ?? now;
  db.prepare(`INSERT INTO file_search_projects
    (project_key, base_dir, display_name, state, source, poll_interval_seconds, created_at, updated_at, last_seen_at, registered_at, last_scan_at, last_error)
    VALUES (?, ?, ?, 'enabled', 'manual-register', ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(project_key) DO UPDATE SET
      base_dir = excluded.base_dir,
      display_name = excluded.display_name,
      state = 'enabled',
      source = 'manual-register',
      updated_at = excluded.updated_at,
      last_seen_at = excluded.last_seen_at,
      registered_at = COALESCE(file_search_projects.registered_at, excluded.registered_at),
      last_error = NULL`).run(
    identity.projectKey,
    identity.baseDir,
    identity.displayName,
    current?.pollIntervalSeconds ?? null,
    current?.createdAt ?? now,
    now,
    now,
    registeredAt,
    current?.lastScanAt ?? null,
  );
  return getFileSearchProject(db, identity.baseDir)!;
}

export function unregisterFileSearchProject(db: BetterSqliteDatabase, baseDir: string): FileSearchProjectEntry {
  ensureFileSearchProjectRegistrySchema(db);
  const identity = resolveFileSearchProjectRegistryIdentity(baseDir);
  const current = getFileSearchProject(db, identity.baseDir);
  const now = nowIso();
  db.prepare(`INSERT INTO file_search_projects
    (project_key, base_dir, display_name, state, source, poll_interval_seconds, created_at, updated_at, last_seen_at, registered_at, last_scan_at, last_error)
    VALUES (?, ?, ?, 'disabled', 'manual-unregister', ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(project_key) DO UPDATE SET
      base_dir = excluded.base_dir,
      display_name = excluded.display_name,
      state = 'disabled',
      source = 'manual-unregister',
      updated_at = excluded.updated_at,
      last_seen_at = excluded.last_seen_at,
      last_error = NULL`).run(
    identity.projectKey,
    identity.baseDir,
    identity.displayName,
    current?.pollIntervalSeconds ?? null,
    current?.createdAt ?? now,
    now,
    now,
    current?.registeredAt ?? null,
    current?.lastScanAt ?? null,
  );
  return getFileSearchProject(db, identity.baseDir)!;
}
