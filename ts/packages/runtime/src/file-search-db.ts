import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { openSqliteSidecarInternal } from './sqlite-sidecar-internal.js';

export interface FileSearchDbOptions {
  baseDir: string;
  dbFile?: string;
}

export interface FileSearchDbHandle {
  path: string;
  db: BetterSqliteDatabase;
  close(): void;
}

const DEFAULT_FILE_SEARCH_DB_FILE = 'byomem-file-search.sqlite';

function resolveFileSearchDbPath(options: FileSearchDbOptions): string {
  const fileName = options.dbFile ?? DEFAULT_FILE_SEARCH_DB_FILE;
  const path = resolve(options.baseDir, fileName);
  const memoriesPath = openSqliteSidecarInternal({ baseDir: options.baseDir }).sidecar.path;
  if (path === memoriesPath) {
    throw new Error('file search DB must not target the memories DB path');
  }
  if (path === resolve(options.baseDir, 'native-store.json')) {
    throw new Error('file search DB must not target the memories DB path');
  }
  return path;
}

function assertFileSearchDbPath(path: string): void {
  const fileName = path.split(/[/\\]/).pop() ?? path;
  if (fileName === 'byomem-index.sqlite' || fileName === 'native-store.json') {
    throw new Error('file search DB must not target the memories DB path');
  }
}

function ensureFileSearchSchema(db: BetterSqliteDatabase): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS file_records (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      path TEXT NOT NULL,
      content_hash TEXT,
      mtime_ms INTEGER,
      size_bytes INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_file_records_project_key ON file_records(project_key);
    CREATE INDEX IF NOT EXISTS idx_file_records_project_path ON file_records(project_key, path);
  `);
  db.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)').run('schema_version', '1');
  db.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)').run('schema_name', 'file-search');
}

export function openFileSearchDb(options: FileSearchDbOptions): FileSearchDbHandle {
  const path = resolveFileSearchDbPath(options);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  ensureFileSearchSchema(db);
  const handle: FileSearchDbHandle = {
    path,
    db,
    close(): void {
      assertFileSearchDbPath(handle.path);
      db.close();
    },
  };
  return handle;
}
