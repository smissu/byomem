import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve, relative, sep, join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { resolveProjectContext } from './project-context.js';
import { FileIndexScheduler } from './file-index-scheduler.js';

export interface FileSearchDbOptions {
  baseDir: string;
  dbFile?: string;
}

export interface FileSearchRefreshEvent {
  kind: 'activation' | 'post-activity' | 'backstop';
  projectKey?: string;
}

export interface FileSearchDbHandle {
  path: string;
  db: BetterSqliteDatabase;
  close(): void;
  scanAndIndex(): void;
  scheduleRefresh(event: FileSearchRefreshEvent): void;
  flushScheduledRefreshes(): void;
  refreshMetrics: { runs: number; failures: number; skips: number; retries: number; lastRunAt?: string; lastFailureAt?: string };
}

const DEFAULT_FILE_SEARCH_DB_FILE = 'byomem-file-search.sqlite';
const IGNORED_DIRS = new Set(['node_modules', '.git']);
const IGNORED_BASENAMES = new Set(['byomem-index.sqlite', 'byomem-file-search.sqlite', 'native-store.json']);
const MAX_ACTIVE_PROJECTS = 3;
const DEBOUNCE_WINDOW_MS = 250;
const BACKSTOP_WINDOW_MS = 60_000;

function isSQLiteCompanion(filePath: string): boolean {
  return /-(wal|shm)$/.test(filePath);
}

function isIgnoredInternalFile(filePath: string): boolean {
  const name = basename(filePath);
  return IGNORED_BASENAMES.has(name) || isSQLiteCompanion(name);
}

interface GitignoreRule {
  basePath: string;
  pattern: string;
  directoryOnly: boolean;
  negated: boolean;
  anchored: boolean;
  hasSlash: boolean;
  regex: RegExp;
}

function normalizePathForGitignore(filePath: string): string {
  return filePath.split(sep).join('/');
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegex(pattern: string): RegExp {
  const source = pattern
    .split('*')
    .map((part) => escapeRegex(part))
    .join('[^/]*');
  return new RegExp(`^${source}$`);
}

function loadGitignoreRules(rootDir: string, currentDir: string): GitignoreRule[] {
  const gitignorePath = join(currentDir, '.gitignore');
  if (!existsSync(gitignorePath)) return [];
  const basePath = normalizePathForGitignore(relative(rootDir, currentDir));
  return readFileSync(gitignorePath, 'utf8')
    .split(/\r?\n/)
    .map((rawLine) => rawLine.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => {
      const negated = line.startsWith('!');
      let pattern = negated ? line.slice(1) : line;
      const anchored = pattern.startsWith('/');
      if (anchored) pattern = pattern.slice(1);
      const directoryOnly = pattern.endsWith('/');
      pattern = pattern.replace(/^\/+|\/+$/g, '');
      return {
        basePath,
        pattern,
        directoryOnly,
        negated,
        anchored,
        hasSlash: pattern.includes('/'),
        regex: globToRegex(pattern),
      };
    })
    .filter((rule) => rule.pattern.length > 0);
}

function pathRelativeToRuleBase(rule: GitignoreRule, relativePath: string): string | undefined {
  const path = normalizePathForGitignore(relativePath);
  if (!path) return undefined;
  if (!rule.basePath) return path;
  if (path === rule.basePath) return '';
  if (!path.startsWith(`${rule.basePath}/`)) return undefined;
  return path.slice(rule.basePath.length + 1);
}

function gitignoreRuleMatches(rule: GitignoreRule, relativePath: string, isDirectory: boolean): boolean {
  const path = pathRelativeToRuleBase(rule, relativePath);
  if (!path) return false;
  const segments = path.split('/');

  if (rule.directoryOnly) {
    if (rule.hasSlash || rule.anchored) {
      return path === rule.pattern || path.startsWith(`${rule.pattern}/`);
    }
    return segments.some((segment) => rule.regex.test(segment));
  }

  if (rule.hasSlash || rule.anchored) {
    return rule.regex.test(path);
  }

  return rule.regex.test(isDirectory ? segments[segments.length - 1] : basename(path));
}

function isGitignored(rules: GitignoreRule[], relativePath: string, isDirectory: boolean): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (gitignoreRuleMatches(rule, relativePath, isDirectory)) ignored = !rule.negated;
  }
  return ignored;
}

function resolveFileSearchDbPath(options: FileSearchDbOptions): string {
  const fileName = options.dbFile ?? DEFAULT_FILE_SEARCH_DB_FILE;
  const resolvedPath = resolve(options.baseDir, fileName);
  const canonicalResolved = resolve(resolvedPath);
  const memoriesDbPath = resolve(options.baseDir, 'byomem-index.sqlite');
  const memoriesSnapshotPath = resolve(options.baseDir, 'native-store.json');
  if (canonicalResolved === memoriesDbPath || canonicalResolved === memoriesSnapshotPath) {
    throw new Error('file search DB must not target the memories DB path');
  }
  return resolvedPath;
}

function assertFileSearchDbPath(path: string): void {
  const canonical = resolve(path);
  const fileName = canonical.split(/[/\\]/).pop() ?? canonical;
  if (fileName === 'byomem-index.sqlite' || fileName === 'native-store.json') {
    throw new Error('file search DB must not target the memories DB path');
  }
}

function ensureFoundationSchema(db: BetterSqliteDatabase): void {
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

function ensureScannerIndexerSchema(db: BetterSqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS scan_prefilter_events (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      file_path TEXT NOT NULL,
      reason TEXT NOT NULL,
      confirmed INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_scan_prefilter_events_project_key ON scan_prefilter_events(project_key);
    CREATE TABLE IF NOT EXISTS content_hash_checks (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      file_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      confirmed INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_content_hash_checks_project_key ON content_hash_checks(project_key);
    CREATE TABLE IF NOT EXISTS indexed_files (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      path TEXT NOT NULL,
      file_record_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(file_record_id) REFERENCES file_records(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_indexed_files_project_key ON indexed_files(project_key);
    CREATE INDEX IF NOT EXISTS idx_indexed_files_project_path ON indexed_files(project_key, path);
    CREATE TABLE IF NOT EXISTS indexed_chunks (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      file_record_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      chunk_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(file_record_id) REFERENCES file_records(id) ON DELETE CASCADE
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS indexed_chunks_fts USING fts5(id UNINDEXED, project_key UNINDEXED, file_record_id UNINDEXED, chunk_index UNINDEXED, chunk_text, chunk_hash, content='indexed_chunks', content_rowid='rowid', tokenize = 'unicode61');
    CREATE TRIGGER IF NOT EXISTS indexed_chunks_ai AFTER INSERT ON indexed_chunks BEGIN
      INSERT INTO indexed_chunks_fts(rowid, id, project_key, file_record_id, chunk_index, chunk_text, chunk_hash) VALUES (new.rowid, new.id, new.project_key, new.file_record_id, new.chunk_index, new.chunk_text, new.chunk_hash);
    END;
    CREATE TRIGGER IF NOT EXISTS indexed_chunks_ad AFTER DELETE ON indexed_chunks BEGIN
      INSERT INTO indexed_chunks_fts(indexed_chunks_fts, rowid, id, project_key, file_record_id, chunk_index, chunk_text, chunk_hash) VALUES('delete', old.rowid, old.id, old.project_key, old.file_record_id, old.chunk_index, old.chunk_text, old.chunk_hash);
    END;
    CREATE TRIGGER IF NOT EXISTS indexed_chunks_au AFTER UPDATE ON indexed_chunks BEGIN
      INSERT INTO indexed_chunks_fts(indexed_chunks_fts, rowid, id, project_key, file_record_id, chunk_index, chunk_text, chunk_hash) VALUES('delete', old.rowid, old.id, old.project_key, old.file_record_id, old.chunk_index, old.chunk_text, old.chunk_hash);
      INSERT INTO indexed_chunks_fts(rowid, id, project_key, file_record_id, chunk_index, chunk_text, chunk_hash) VALUES (new.rowid, new.id, new.project_key, new.file_record_id, new.chunk_index, new.chunk_text, new.chunk_hash);
    END;
    CREATE INDEX IF NOT EXISTS idx_indexed_chunks_project_key ON indexed_chunks(project_key);
    CREATE INDEX IF NOT EXISTS idx_indexed_chunks_file_record_id ON indexed_chunks(file_record_id);
    CREATE TABLE IF NOT EXISTS changed_files (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      file_path TEXT NOT NULL,
      change_state TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_changed_files_project_key ON changed_files(project_key);
    CREATE TABLE IF NOT EXISTS reconciled_files (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      file_path TEXT NOT NULL,
      reconciliation_state TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reconciled_files_project_key ON reconciled_files(project_key);
  `);
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function chunkContent(content: string): string[] {
  return content.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

function walkFiles(rootDir: string): string[] {
  const files: string[] = [];
  const queue: Array<{ dir: string; rules: GitignoreRule[] }> = [{ dir: rootDir, rules: [] }];
  while (queue.length) {
    const current = queue.shift()!;
    const gitignoreRules = [...current.rules, ...loadGitignoreRules(rootDir, current.dir)];
    for (const entry of readdirSync(current.dir, { withFileTypes: true })) {
      const fullPath = join(current.dir, entry.name);
      const relativePath = relative(rootDir, fullPath);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && !isGitignored(gitignoreRules, relativePath, true)) queue.push({ dir: fullPath, rules: gitignoreRules });
        continue;
      }
      if (entry.isFile() && !isIgnoredInternalFile(fullPath) && !isGitignored(gitignoreRules, relativePath, false)) files.push(fullPath);
    }
  }
  return files;
}

function deriveProjectKey(baseDir: string): string {
  const context = resolveProjectContext({}, baseDir);
  return `project:${context.projectKey}`;
}

function relPath(baseDir: string, filePath: string): string {
  return relative(baseDir, filePath) || basename(filePath);
}

function upsertRow(db: BetterSqliteDatabase, sql: string, params: unknown[]): void {
  db.prepare(sql).run(...params.map((value) => (typeof value === 'boolean' ? (value ? 1 : 0) : value)));
}

function ensureIndexedSnapshot(db: BetterSqliteDatabase, projectKey: string, rel: string, filePath: string, contentHash: string, stats: { mtimeMs: number; size: number }, content: string, now: string): void {
  const recordId = `file-record:${projectKey}:${rel}`;
  const current = db.prepare('SELECT * FROM file_records WHERE id = ?').get(recordId) as { content_hash?: string | null; mtime_ms?: number | null; size_bytes?: number | null; created_at?: string | null } | undefined;
  const isNew = !current;
  const metadataChanged = Boolean(current && (current.mtime_ms !== stats.mtimeMs || current.size_bytes !== stats.size));
  const hashConfirmed = !current || current.content_hash !== contentHash || metadataChanged;

  if (current && current.content_hash === contentHash && current.mtime_ms === stats.mtimeMs && current.size_bytes === stats.size) return;

  upsertRow(db, 'INSERT OR REPLACE INTO file_records (id, project_key, path, content_hash, mtime_ms, size_bytes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
    recordId,
    projectKey,
    filePath,
    contentHash,
    stats.mtimeMs,
    stats.size,
    current?.created_at ?? now,
    now,
  ]);
  upsertRow(db, 'INSERT OR REPLACE INTO indexed_files (id, project_key, path, file_record_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
    `indexed-file:${projectKey}:${rel}`,
    projectKey,
    filePath,
    recordId,
    current?.created_at ?? now,
    now,
  ]);
  upsertRow(db, 'INSERT OR REPLACE INTO changed_files (id, project_key, file_path, change_state, created_at) VALUES (?, ?, ?, ?, ?)', [
    `changed:${projectKey}:${rel}`,
    projectKey,
    filePath,
    hashConfirmed ? 'confirmed-by-hash' : 'new',
    now,
  ]);
  upsertRow(db, 'INSERT OR REPLACE INTO reconciled_files (id, project_key, file_path, reconciliation_state, created_at) VALUES (?, ?, ?, ?, ?)', [
    `reconciled:${projectKey}:${rel}`,
    projectKey,
    filePath,
    isNew ? 'new' : 'changed',
    now,
  ]);
  db.prepare('DELETE FROM indexed_chunks WHERE file_record_id = ?').run(recordId);
  const chunks = chunkContent(content);
  chunks.forEach((chunkText, chunkIndex) => {
    upsertRow(db, 'INSERT OR REPLACE INTO indexed_chunks (id, project_key, file_record_id, chunk_index, chunk_text, chunk_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      `indexed-chunk:${projectKey}:${rel}:${chunkIndex}`,
      projectKey,
      recordId,
      chunkIndex,
      chunkText,
      hashContent(chunkText),
      now,
      now,
    ]);
  });
}

function scanAndIndexFiles(db: BetterSqliteDatabase, baseDir: string): void {
  const projectKey = deriveProjectKey(baseDir);
  const now = new Date().toISOString();
  const files = walkFiles(baseDir).filter((filePath) => !isIgnoredInternalFile(filePath));
  const seen = new Set<string>();

  for (const filePath of files) {
    const rel = relPath(baseDir, filePath);
    seen.add(rel);
    const stats = statSync(filePath);
    const prefilterId = `prefilter:${projectKey}:${rel}`;
    const content = readFileSync(filePath, 'utf8');
    const contentHash = hashContent(content);
    const current = db.prepare('SELECT * FROM file_records WHERE id = ?').get(`file-record:${projectKey}:${rel}`) as { mtime_ms?: number | null; size_bytes?: number | null } | undefined;
    const prefilterMatches = Boolean(current && current.mtime_ms === stats.mtimeMs && current.size_bytes === stats.size);

    upsertRow(db, 'INSERT OR REPLACE INTO scan_prefilter_events (id, project_key, file_path, reason, confirmed, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      prefilterId,
      projectKey,
      filePath,
      'mtime-size',
      prefilterMatches,
      now,
    ]);
    upsertRow(db, 'INSERT OR REPLACE INTO content_hash_checks (id, project_key, file_path, content_hash, confirmed, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      `hash:${projectKey}:${rel}`,
      projectKey,
      filePath,
      contentHash,
      true,
      now,
    ]);
    ensureIndexedSnapshot(db, projectKey, rel, filePath, contentHash, { mtimeMs: stats.mtimeMs, size: stats.size }, content, now);
  }

  const existing = db.prepare('SELECT id, path, file_record_id, project_key FROM indexed_files WHERE project_key = ?').all(projectKey) as Array<{ id: string; path: string; file_record_id: string; project_key: string }>;
  for (const row of existing) {
    const relativePath = relPath(baseDir, row.path);
    if (seen.has(relativePath)) continue;
    upsertRow(db, 'INSERT OR REPLACE INTO reconciled_files (id, project_key, file_path, reconciliation_state, created_at) VALUES (?, ?, ?, ?, ?)', [
      `reconciled:${projectKey}:${relativePath}:deleted`,
      projectKey,
      row.path,
      'deleted',
      now,
    ]);
    db.prepare('DELETE FROM indexed_chunks WHERE file_record_id = ?').run(row.file_record_id);
    db.prepare('DELETE FROM indexed_files WHERE id = ?').run(row.id);
    db.prepare('DELETE FROM file_records WHERE id = ?').run(row.file_record_id);
    db.prepare('INSERT OR REPLACE INTO changed_files (id, project_key, file_path, change_state, created_at) VALUES (?, ?, ?, ?, ?)').run(`changed:${projectKey}:${relativePath}:deleted`, projectKey, row.path, 'deleted', now);
  }
}

export function openFileSearchDb(options: FileSearchDbOptions): FileSearchDbHandle {
  const path = resolveFileSearchDbPath(options);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  ensureFoundationSchema(db);
  ensureScannerIndexerSchema(db);
  const scheduler = new FileIndexScheduler({
    scanAndIndex: () => scanAndIndexFiles(db, options.baseDir),
  } as FileSearchDbHandle, options.baseDir, { maxActiveProjects: MAX_ACTIVE_PROJECTS, debounceWindowMs: DEBOUNCE_WINDOW_MS, backstopWindowMs: BACKSTOP_WINDOW_MS });

  const handle: FileSearchDbHandle = {
    path,
    db,
    refreshMetrics: scheduler.refreshMetrics,
    scanAndIndex(): void {
      scanAndIndexFiles(db, options.baseDir);
    },
    scheduleRefresh(event: FileSearchRefreshEvent): void {
      scheduler.scheduleRefresh(event);
    },
    flushScheduledRefreshes(): void {
      scheduler.flushScheduledRefreshes();
    },
    close(): void {
      scheduler.close();
      assertFileSearchDbPath(handle.path);
      db.close();
    },
  };
  handle.scanAndIndex();
  return handle;
}
