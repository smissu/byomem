import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve, relative, sep, join, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { resolveProjectContext } from './project-context.js';
import { FileIndexScheduler } from './file-index-scheduler.js';
import { openEmbeddingClient, type EmbeddingClient } from './embedding-client.js';
import { DEFAULT_EMBEDDING_DIMENSION, encodeEmbedding, truncateEmbeddingText } from './embedding-vector.js';
import { ensureFileSearchProjectRegistrySchema, getFileSearchProject, markFileSearchProjectSeen, serializeFileSearchPollingStatus } from './file-search-project-registry.js';

export interface FileSearchDbOptions {
  /** Project root to scan and use for project_key/status identity. */
  baseDir?: string;
  projectBaseDir?: string;
  /** Explicit physical SQLite file path/name override. Relative paths resolve under dbBaseDir. */
  dbFile?: string;
  /** Physical DB storage root override. Defaults to BYOMEM_RUNTIME_BASE_DIR or ~/.byomem/runtime. */
  dbBaseDir?: string;
  embeddingBaseUrl?: string;
  embeddingModel?: string;
  embeddingDimension?: number;
  embeddingTimeoutMs?: number;
  embeddingRequireRemote?: boolean;
  semanticSearchEnabled?: boolean;
  embeddingBatchSize?: number;
  scanOnOpen?: boolean;
  schedulerEnabled?: boolean;
  scannerStaleAfterMs?: number;
}

export interface FileSearchEmbeddingDiagnostics {
  enabled: boolean;
  model: string;
  configuredDimension: number;
  embeddedChunks: number;
  missingChunks: number;
  failures: number;
  fallbacks: number;
  lastError?: string;
}

export interface FileSearchRefreshEvent {
  kind: 'activation' | 'post-activity' | 'backstop';
  projectKey?: string;
}

export type FileSearchScannerState = 'idle' | 'running' | 'completed' | 'failed' | 'abandoned';
export type FileSearchScannerTrigger = 'open' | 'manual' | 'poll' | 'scheduler-activation' | 'scheduler-post-activity' | 'scheduler-backstop';

export interface FileSearchScannerProgress {
  discoveredFiles: number;
  scannedFiles: number;
  indexedFiles: number;
  unchangedFiles: number;
  changedFiles: number;
  deletedFiles: number;
  ignoredFiles: number;
  errorFiles: number;
  chunksWritten: number;
  bytesRead?: number;
  filesRemaining?: number;
}

export interface FileSearchScannerDatabaseCounts {
  indexedFiles: number;
  indexedChunks: number;
  changedRows: number;
  reconciledRows: number;
  projects: Array<{ projectKey: string; files: number }>;
}

export interface FileSearchScannerStatus {
  state: FileSearchScannerState;
  projectKey: string;
  baseDir: string;
  polling_enabled: boolean;
  poll_interval_seconds: number | null;
  last_poll_at: string | null;
  next_poll_at: string | null;
  consecutive_no_change_polls: number;
  idle_disable_after_polls: number | null;
  polling_disabled_reason: string | null;
  last_scan_at: string | null;
  runId?: string;
  trigger?: FileSearchScannerTrigger;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  currentPath?: string;
  lastPath?: string;
  lastError?: string;
  updatedAt?: string;
  progress: FileSearchScannerProgress;
  database: FileSearchScannerDatabaseCounts;
  embeddings?: FileSearchEmbeddingDiagnostics;
}

type FileSearchPersistedScannerStatus = Omit<FileSearchScannerStatus,
  | 'database'
  | 'embeddings'
  | 'polling_enabled'
  | 'poll_interval_seconds'
  | 'last_poll_at'
  | 'next_poll_at'
  | 'consecutive_no_change_polls'
  | 'idle_disable_after_polls'
  | 'polling_disabled_reason'
  | 'last_scan_at'
>;

export interface FileSearchRegistryDbHandle {
  path: string;
  db: BetterSqliteDatabase;
  close(): void;
}

export interface FileSearchDbHandle {
  path: string;
  db: BetterSqliteDatabase;
  close(): void;
  scanAndIndex(options?: { trigger?: FileSearchScannerTrigger }): FileSearchScannerStatus;
  getScannerStatus(): FileSearchScannerStatus;
  refreshSemanticIndex(options?: { limit?: number }): Promise<FileSearchEmbeddingDiagnostics>;
  getEmbeddingDiagnostics(): FileSearchEmbeddingDiagnostics;
  embedQuery(text: string): Promise<number[] | undefined>;
  semanticSearchEnabled: boolean;
  embeddingModel: string;
  embeddingConfiguredDimension: number;
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
const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text';
const DEFAULT_SCANNER_STALE_AFTER_MS = 5 * 60_000;

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

function resolveProjectBaseDir(options: FileSearchDbOptions): string {
  const projectBaseDir = options.projectBaseDir ?? options.baseDir;
  if (!projectBaseDir?.trim()) throw new Error('file search project baseDir is required');
  return resolve(projectBaseDir);
}

function resolveDefaultRuntimeBaseDir(): string {
  const override = process.env.BYOMEM_RUNTIME_BASE_DIR?.trim();
  return override ? resolve(override) : resolve(homedir(), '.byomem', 'runtime');
}

export function resolveDefaultFileSearchDbPath(options: Pick<FileSearchDbOptions, 'dbBaseDir' | 'dbFile'> = {}): string {
  const dbBaseDir = options.dbBaseDir ?? resolveDefaultRuntimeBaseDir();
  const dbFile = options.dbFile ?? DEFAULT_FILE_SEARCH_DB_FILE;
  return resolve(dbBaseDir, dbFile);
}

function resolveFileSearchDbPath(options: FileSearchDbOptions, projectBaseDir: string): string {
  const resolvedPath = options.dbFile
    ? resolve(options.dbBaseDir ?? projectBaseDir, options.dbFile)
    : resolveDefaultFileSearchDbPath({ dbBaseDir: options.dbBaseDir });
  const canonicalResolved = resolve(resolvedPath);
  const memoriesDbPath = resolve(projectBaseDir, 'byomem-index.sqlite');
  const memoriesSnapshotPath = resolve(projectBaseDir, 'native-store.json');
  if (canonicalResolved === memoriesDbPath || canonicalResolved === memoriesSnapshotPath) {
    throw new Error('file search DB must not target the memories DB path');
  }
  assertFileSearchDbPath(canonicalResolved);
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
    CREATE TABLE IF NOT EXISTS file_embedding_cache (
      id TEXT PRIMARY KEY,
      text_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      configured_dimension INTEGER NOT NULL,
      embedding BLOB NOT NULL,
      dimension INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_file_embedding_cache_lookup ON file_embedding_cache(text_hash, model, configured_dimension);
    CREATE TABLE IF NOT EXISTS indexed_chunk_embeddings (
      chunk_id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      file_record_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_hash TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      configured_dimension INTEGER NOT NULL,
      embedding BLOB NOT NULL,
      dimension INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'ready',
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(chunk_id) REFERENCES indexed_chunks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_indexed_chunk_embeddings_project_key ON indexed_chunk_embeddings(project_key);
    CREATE INDEX IF NOT EXISTS idx_indexed_chunk_embeddings_model ON indexed_chunk_embeddings(model, configured_dimension, status);
  `);
}

function ensureScannerStatusSchema(db: BetterSqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_search_scanner_status (
      project_key TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      run_id TEXT,
      trigger TEXT,
      base_dir TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      duration_ms INTEGER,
      current_path TEXT,
      last_path TEXT,
      last_error TEXT,
      progress_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function chunkContent(content: string): string[] {
  return content.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

interface WalkFilesResult {
  files: string[];
  ignoredFiles: number;
}

function walkFiles(rootDir: string): WalkFilesResult {
  const files: string[] = [];
  let ignoredFiles = 0;
  const queue: Array<{ dir: string; rules: GitignoreRule[] }> = [{ dir: rootDir, rules: [] }];
  while (queue.length) {
    const current = queue.shift()!;
    const gitignoreRules = [...current.rules, ...loadGitignoreRules(rootDir, current.dir)];
    for (const entry of readdirSync(current.dir, { withFileTypes: true })) {
      const fullPath = join(current.dir, entry.name);
      const relativePath = relative(rootDir, fullPath);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && !isGitignored(gitignoreRules, relativePath, true)) queue.push({ dir: fullPath, rules: gitignoreRules });
        else ignoredFiles += 1;
        continue;
      }
      if (!entry.isFile()) continue;
      if (isIgnoredInternalFile(fullPath) || isGitignored(gitignoreRules, relativePath, false)) {
        ignoredFiles += 1;
        continue;
      }
      files.push(fullPath);
    }
  }
  return { files, ignoredFiles };
}

export function resolveFileSearchProjectKey(baseDir: string): string {
  const resolvedBaseDir = resolve(baseDir);
  const context = resolveProjectContext({}, resolvedBaseDir);
  const pathHash = createHash('sha256').update(resolve(context.repoRoot || resolvedBaseDir)).digest('hex').slice(0, 12);
  return `project:${context.projectKey}-${pathHash}`;
}

function deriveProjectKey(baseDir: string): string {
  return resolveFileSearchProjectKey(baseDir);
}

function relPath(baseDir: string, filePath: string): string {
  return relative(baseDir, filePath) || basename(filePath);
}

function emptyScannerProgress(overrides: Partial<FileSearchScannerProgress> = {}): FileSearchScannerProgress {
  return {
    discoveredFiles: 0,
    scannedFiles: 0,
    indexedFiles: 0,
    unchangedFiles: 0,
    changedFiles: 0,
    deletedFiles: 0,
    ignoredFiles: 0,
    errorFiles: 0,
    chunksWritten: 0,
    filesRemaining: 0,
    ...overrides,
  };
}

function scannerDatabaseCounts(db: BetterSqliteDatabase, projectKey: string): FileSearchScannerDatabaseCounts {
  const indexedFiles = db.prepare('SELECT COUNT(*) AS count FROM indexed_files WHERE project_key = ?').get(projectKey) as { count: number };
  const indexedChunks = db.prepare('SELECT COUNT(*) AS count FROM indexed_chunks WHERE project_key = ?').get(projectKey) as { count: number };
  const changedRows = db.prepare('SELECT COUNT(*) AS count FROM changed_files WHERE project_key = ?').get(projectKey) as { count: number };
  const reconciledRows = db.prepare('SELECT COUNT(*) AS count FROM reconciled_files WHERE project_key = ?').get(projectKey) as { count: number };
  const projects = db.prepare('SELECT project_key AS projectKey, COUNT(*) AS files FROM indexed_files GROUP BY project_key ORDER BY project_key').all() as Array<{ projectKey: string; files: number }>;
  return { indexedFiles: indexedFiles.count, indexedChunks: indexedChunks.count, changedRows: changedRows.count, reconciledRows: reconciledRows.count, projects };
}

function normalizeProgress(value: string | null | undefined): FileSearchScannerProgress {
  if (!value) return emptyScannerProgress();
  try {
    const parsed = JSON.parse(value) as Partial<FileSearchScannerProgress>;
    return emptyScannerProgress(parsed);
  } catch {
    return emptyScannerProgress();
  }
}

function persistScannerStatus(db: BetterSqliteDatabase, projectKey: string, status: FileSearchPersistedScannerStatus): void {
  const updatedAt = new Date().toISOString();
  db.prepare(`INSERT OR REPLACE INTO file_search_scanner_status
    (project_key, state, run_id, trigger, base_dir, started_at, completed_at, duration_ms, current_path, last_path, last_error, progress_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      projectKey,
      status.state,
      status.runId ?? null,
      status.trigger ?? null,
      status.baseDir,
      status.startedAt ?? null,
      status.completedAt ?? null,
      status.durationMs ?? null,
      status.currentPath ?? null,
      status.lastPath ?? null,
      status.lastError ?? null,
      JSON.stringify(status.progress),
      updatedAt,
    );
}

function readPersistedScannerStatus(db: BetterSqliteDatabase, projectKey: string): (FileSearchPersistedScannerStatus & { progress: FileSearchScannerProgress }) | undefined {
  const row = db.prepare('SELECT * FROM file_search_scanner_status WHERE project_key = ?').get(projectKey) as {
    project_key: string;
    state: FileSearchScannerState;
    run_id?: string | null;
    trigger?: FileSearchScannerTrigger | null;
    base_dir: string;
    started_at?: string | null;
    completed_at?: string | null;
    duration_ms?: number | null;
    current_path?: string | null;
    last_path?: string | null;
    last_error?: string | null;
    progress_json?: string | null;
    updated_at?: string | null;
  } | undefined;
  if (!row) return undefined;
  return {
    state: row.state,
    projectKey: row.project_key,
    baseDir: row.base_dir,
    runId: row.run_id ?? undefined,
    trigger: row.trigger ?? undefined,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    currentPath: row.current_path ?? undefined,
    lastPath: row.last_path ?? undefined,
    lastError: row.last_error ?? undefined,
    updatedAt: row.updated_at ?? undefined,
    progress: normalizeProgress(row.progress_json),
  };
}

function upsertRow(db: BetterSqliteDatabase, sql: string, params: unknown[]): void {
  db.prepare(sql).run(...params.map((value) => (typeof value === 'boolean' ? (value ? 1 : 0) : value)));
}

function ensureIndexedSnapshot(db: BetterSqliteDatabase, projectKey: string, rel: string, filePath: string, contentHash: string, stats: { mtimeMs: number; size: number }, content: string, now: string): { changed: boolean; chunksWritten: number } {
  const recordId = `file-record:${projectKey}:${rel}`;
  const current = db.prepare('SELECT * FROM file_records WHERE id = ?').get(recordId) as { content_hash?: string | null; mtime_ms?: number | null; size_bytes?: number | null; created_at?: string | null } | undefined;
  const isNew = !current;
  const metadataChanged = Boolean(current && (current.mtime_ms !== stats.mtimeMs || current.size_bytes !== stats.size));
  const hashConfirmed = !current || current.content_hash !== contentHash || metadataChanged;

  if (current && current.content_hash === contentHash && current.mtime_ms === stats.mtimeMs && current.size_bytes === stats.size) return { changed: false, chunksWritten: 0 };

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
  return { changed: true, chunksWritten: chunks.length };
}

function scanAndIndexFiles(db: BetterSqliteDatabase, baseDir: string, progress: FileSearchScannerProgress, onProgress?: (currentPath?: string, lastPath?: string) => void): { lastPath?: string } {
  const projectKey = deriveProjectKey(baseDir);
  const now = new Date().toISOString();
  const walked = walkFiles(baseDir);
  const files = walked.files.filter((filePath) => !isIgnoredInternalFile(filePath));
  const seen = new Set<string>();
  let lastPath: string | undefined;
  progress.discoveredFiles = files.length;
  progress.ignoredFiles = walked.ignoredFiles;
  progress.filesRemaining = files.length;
  onProgress?.();

  for (const filePath of files) {
    const rel = relPath(baseDir, filePath);
    try {
      lastPath = rel;
      onProgress?.(rel, lastPath);
      seen.add(rel);
      const stats = statSync(filePath);
      const prefilterId = `prefilter:${projectKey}:${rel}`;
      const content = readFileSync(filePath, 'utf8');
      progress.bytesRead = (progress.bytesRead ?? 0) + Buffer.byteLength(content, 'utf8');
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
      const result = ensureIndexedSnapshot(db, projectKey, rel, filePath, contentHash, { mtimeMs: stats.mtimeMs, size: stats.size }, content, now);
      progress.scannedFiles += 1;
      progress.filesRemaining = Math.max(0, (progress.filesRemaining ?? 0) - 1);
      if (!result.changed) progress.unchangedFiles += 1;
      else {
        progress.indexedFiles += 1;
        progress.changedFiles += 1;
        progress.chunksWritten += result.chunksWritten;
      }
      if (progress.scannedFiles === 1 || progress.scannedFiles % 25 === 0 || progress.filesRemaining === 0) onProgress?.(rel, lastPath);
    } catch (error) {
      progress.errorFiles += 1;
      progress.filesRemaining = Math.max(0, (progress.filesRemaining ?? 0) - 1);
      onProgress?.(rel, lastPath);
      throw error;
    }
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
    progress.deletedFiles += 1;
  }
  return { lastPath };
}

function embeddingModel(options: FileSearchDbOptions): string {
  return options.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
}

function embeddingConfiguredDimension(options: FileSearchDbOptions): number {
  return options.embeddingDimension ?? 0;
}

function semanticEnabled(options: FileSearchDbOptions): boolean {
  return Boolean(options.semanticSearchEnabled ?? true);
}

function cacheId(textHash: string, model: string, configuredDimension: number): string {
  return `${model}:${configuredDimension}:${textHash}`;
}

function embeddingDiagnostics(db: BetterSqliteDatabase, options: FileSearchDbOptions): FileSearchEmbeddingDiagnostics {
  const model = embeddingModel(options);
  const configuredDimension = embeddingConfiguredDimension(options);
  const embedded = db.prepare('SELECT COUNT(*) AS count FROM indexed_chunk_embeddings WHERE model = ? AND configured_dimension = ? AND status = ?').get(model, configuredDimension, 'ready') as { count: number };
  const missing = db.prepare(`
    SELECT COUNT(*) AS count
    FROM indexed_chunks c
    LEFT JOIN indexed_chunk_embeddings e ON e.chunk_id = c.id AND e.model = ? AND e.configured_dimension = ? AND e.status = 'ready' AND e.chunk_hash = c.chunk_hash
    WHERE e.chunk_id IS NULL
  `).get(model, configuredDimension) as { count: number };
  const failures = db.prepare('SELECT COUNT(*) AS count FROM indexed_chunk_embeddings WHERE model = ? AND configured_dimension = ? AND status = ?').get(model, configuredDimension, 'failed') as { count: number };
  const lastFailure = db.prepare('SELECT error FROM indexed_chunk_embeddings WHERE model = ? AND configured_dimension = ? AND status = ? AND error IS NOT NULL ORDER BY updated_at DESC LIMIT 1').get(model, configuredDimension, 'failed') as { error?: string } | undefined;
  return { enabled: semanticEnabled(options), model, configuredDimension, embeddedChunks: embedded.count, missingChunks: missing.count, failures: failures.count, fallbacks: 0, lastError: lastFailure?.error };
}

async function refreshSemanticIndex(db: BetterSqliteDatabase, options: FileSearchDbOptions, embeddingClient: EmbeddingClient, refreshOptions: { limit?: number } = {}): Promise<FileSearchEmbeddingDiagnostics> {
  if (!semanticEnabled(options)) return embeddingDiagnostics(db, options);
  const model = embeddingModel(options);
  const configuredDimension = embeddingConfiguredDimension(options);
  const limit = Math.max(1, refreshOptions.limit ?? options.embeddingBatchSize ?? 100);
  const rows = db.prepare(`
    SELECT c.id, c.project_key, c.file_record_id, c.chunk_index, c.chunk_text, c.chunk_hash
    FROM indexed_chunks c
    LEFT JOIN indexed_chunk_embeddings e ON e.chunk_id = c.id AND e.model = ? AND e.configured_dimension = ? AND e.status = 'ready' AND e.chunk_hash = c.chunk_hash
    WHERE e.chunk_id IS NULL
    ORDER BY c.project_key, c.file_record_id, c.chunk_index
    LIMIT ?
  `).all(model, configuredDimension, limit) as Array<{ id: string; project_key: string; file_record_id: string; chunk_index: number; chunk_text: string; chunk_hash: string }>;
  const now = new Date().toISOString();
  for (const row of rows) {
    const embeddingText = truncateEmbeddingText(row.chunk_text);
    const textHash = embeddingClient.hashText(embeddingText);
    const id = cacheId(textHash, model, configuredDimension);
    try {
      const cached = db.prepare('SELECT embedding, dimension FROM file_embedding_cache WHERE id = ?').get(id) as { embedding: Buffer; dimension: number } | undefined;
      const vector = cached ? undefined : await embeddingClient.embed(embeddingText);
      if (!cached && !vector?.length) continue;
      const embedding = cached?.embedding ?? encodeEmbedding(vector!);
      const dimension = cached?.dimension ?? vector!.length;
      if (!cached) db.prepare('INSERT OR REPLACE INTO file_embedding_cache (id, text_hash, model, configured_dimension, embedding, dimension, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, textHash, model, configuredDimension, embedding, dimension, now);
      db.prepare(`INSERT OR REPLACE INTO indexed_chunk_embeddings (chunk_id, project_key, file_record_id, chunk_index, chunk_hash, text_hash, model, configured_dimension, embedding, dimension, status, error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', NULL, COALESCE((SELECT created_at FROM indexed_chunk_embeddings WHERE chunk_id = ?), ?), ?)`).run(row.id, row.project_key, row.file_record_id, row.chunk_index, row.chunk_hash, textHash, model, configuredDimension, embedding, dimension, row.id, now, now);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      db.prepare(`INSERT OR REPLACE INTO indexed_chunk_embeddings (chunk_id, project_key, file_record_id, chunk_index, chunk_hash, text_hash, model, configured_dimension, embedding, dimension, status, error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?, COALESCE((SELECT created_at FROM indexed_chunk_embeddings WHERE chunk_id = ?), ?), ?)`).run(row.id, row.project_key, row.file_record_id, row.chunk_index, row.chunk_hash, textHash, model, configuredDimension, Buffer.alloc(0), 0, message, row.id, now, now);
      if (options.embeddingRequireRemote) throw error;
    }
  }
  return embeddingDiagnostics(db, options);
}

export function openFileSearchRegistryDb(options: Pick<FileSearchDbOptions, 'dbBaseDir' | 'dbFile'> = {}): FileSearchRegistryDbHandle {
  const path = resolveDefaultFileSearchDbPath(options);
  const canonicalPath = resolve(path);
  assertFileSearchDbPath(canonicalPath);
  mkdirSync(dirname(canonicalPath), { recursive: true });
  const db = new Database(canonicalPath);
  ensureFoundationSchema(db);
  ensureFileSearchProjectRegistrySchema(db);
  return {
    path: canonicalPath,
    db,
    close(): void {
      assertFileSearchDbPath(canonicalPath);
      db.close();
    },
  };
}

export function openFileSearchDb(options: FileSearchDbOptions): FileSearchDbHandle {
  const projectBaseDir = resolveProjectBaseDir(options);
  const path = resolveFileSearchDbPath(options, projectBaseDir);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  ensureFoundationSchema(db);
  ensureScannerIndexerSchema(db);
  ensureScannerStatusSchema(db);
  ensureFileSearchProjectRegistrySchema(db);
  const projectKey = deriveProjectKey(projectBaseDir);
  const scanOnOpen = options.scanOnOpen ?? true;
  const schedulerEnabled = options.schedulerEnabled ?? true;
  const scannerStaleAfterMs = options.scannerStaleAfterMs ?? DEFAULT_SCANNER_STALE_AFTER_MS;
  const runningOnOpen = readPersistedScannerStatus(db, projectKey)?.state === 'running';
  let activeRunId: string | undefined;
  const isStaleRunning = (status: FileSearchPersistedScannerStatus & { progress: FileSearchScannerProgress }): boolean => {
    const updatedAt = status.updatedAt ?? status.startedAt;
    if (!updatedAt) return true;
    const updatedMs = Date.parse(updatedAt);
    if (!Number.isFinite(updatedMs)) return true;
    return Date.now() - updatedMs >= scannerStaleAfterMs;
  };
  const withPollingFields = (status: Omit<FileSearchScannerStatus, 'database' | 'embeddings' | 'polling_enabled' | 'poll_interval_seconds' | 'last_poll_at' | 'next_poll_at' | 'consecutive_no_change_polls' | 'idle_disable_after_polls' | 'polling_disabled_reason' | 'last_scan_at'> & { database: FileSearchScannerDatabaseCounts; embeddings?: FileSearchEmbeddingDiagnostics }): FileSearchScannerStatus => {
    const entry = getFileSearchProject(db, projectBaseDir);
    const polling = entry
      ? serializeFileSearchPollingStatus(entry)
      : {
          polling_enabled: false,
          poll_interval_seconds: null,
          last_poll_at: null,
          next_poll_at: null,
          consecutive_no_change_polls: 0,
          idle_disable_after_polls: null,
          polling_disabled_reason: 'default-off' as const,
          last_scan_at: null,
        };
    return { ...status, ...polling };
  };
  const buildScannerStatus = (): FileSearchScannerStatus => {
    const persisted = readPersistedScannerStatus(db, projectKey);
    if (!persisted) {
      return withPollingFields({ state: 'idle', projectKey, baseDir: projectBaseDir, progress: emptyScannerProgress(), database: scannerDatabaseCounts(db, projectKey), embeddings: embeddingDiagnostics(db, options) });
    }
    if (persisted.state === 'running' && persisted.runId !== activeRunId && isStaleRunning(persisted)) {
      const completedAt = new Date().toISOString();
      const durationMs = persisted.startedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(persisted.startedAt)) : undefined;
      const abandoned = {
        ...persisted,
        state: 'abandoned' as const,
        completedAt,
        durationMs,
        currentPath: undefined,
        lastError: persisted.lastError ?? 'Scanner run abandoned: stale running snapshot from an interrupted process',
      };
      persistScannerStatus(db, projectKey, abandoned);
      return withPollingFields({ ...abandoned, database: scannerDatabaseCounts(db, projectKey), embeddings: embeddingDiagnostics(db, options) });
    }
    return withPollingFields({ ...persisted, database: scannerDatabaseCounts(db, projectKey), embeddings: embeddingDiagnostics(db, options) });
  };
  const runScan = (trigger: FileSearchScannerTrigger): FileSearchScannerStatus => {
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const progress = emptyScannerProgress();
    activeRunId = runId;
    const persistRunning = (currentPath?: string, lastPath?: string): void => {
      persistScannerStatus(db, projectKey, { state: 'running', projectKey, baseDir: projectBaseDir, runId, trigger, startedAt, currentPath, lastPath, progress: { ...progress } });
    };
    persistRunning();
    try {
      const result = scanAndIndexFiles(db, projectBaseDir, progress, persistRunning);
      const completedAt = new Date().toISOString();
      persistScannerStatus(db, projectKey, {
        state: 'completed',
        projectKey,
        baseDir: projectBaseDir,
        runId,
        trigger,
        startedAt,
        completedAt,
        durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
        lastPath: result.lastPath,
        progress: { ...progress, filesRemaining: 0 },
      });
      return buildScannerStatus();
    } catch (error) {
      const completedAt = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      persistScannerStatus(db, projectKey, {
        state: 'failed',
        projectKey,
        baseDir: projectBaseDir,
        runId,
        trigger,
        startedAt,
        completedAt,
        durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
        lastError: message,
        progress,
      });
      throw error;
    } finally {
      activeRunId = undefined;
    }
  };
  const embeddingClient = openEmbeddingClient({
    baseUrl: options.embeddingBaseUrl,
    model: options.embeddingModel,
    dimension: options.embeddingDimension ?? DEFAULT_EMBEDDING_DIMENSION,
    timeoutMs: options.embeddingTimeoutMs,
    requireRemote: options.embeddingRequireRemote,
  });
  const scheduler = schedulerEnabled
    ? new FileIndexScheduler({
        scanAndIndex: (scanOptions?: { trigger?: FileSearchScannerTrigger }) => runScan(scanOptions?.trigger ?? 'manual'),
      } as FileSearchDbHandle, projectBaseDir, { maxActiveProjects: MAX_ACTIVE_PROJECTS, debounceWindowMs: DEBOUNCE_WINDOW_MS, backstopWindowMs: BACKSTOP_WINDOW_MS })
    : undefined;

  const handle: FileSearchDbHandle = {
    path,
    db,
    semanticSearchEnabled: semanticEnabled(options),
    embeddingModel: embeddingModel(options),
    embeddingConfiguredDimension: embeddingConfiguredDimension(options),
    refreshMetrics: scheduler?.refreshMetrics ?? { runs: 0, failures: 0, skips: 0, retries: 0 },
    scanAndIndex(scanOptions?: { trigger?: FileSearchScannerTrigger }): FileSearchScannerStatus {
      const trigger = scanOptions?.trigger ?? 'manual';
      runScan(trigger);
      if (trigger === 'manual') markFileSearchProjectSeen(db, projectBaseDir, 'manual-scan');
      return buildScannerStatus();
    },
    getScannerStatus(): FileSearchScannerStatus {
      return buildScannerStatus();
    },
    refreshSemanticIndex(refreshOptions?: { limit?: number }): Promise<FileSearchEmbeddingDiagnostics> {
      return refreshSemanticIndex(db, options, embeddingClient, refreshOptions);
    },
    getEmbeddingDiagnostics(): FileSearchEmbeddingDiagnostics {
      return embeddingDiagnostics(db, options);
    },
    embedQuery(text: string): Promise<number[] | undefined> {
      return semanticEnabled(options) ? embeddingClient.embed(truncateEmbeddingText(text)) : Promise.resolve(undefined);
    },
    scheduleRefresh(event: FileSearchRefreshEvent): void {
      scheduler?.scheduleRefresh(event);
    },
    flushScheduledRefreshes(): void {
      scheduler?.flushScheduledRefreshes();
    },
    close(): void {
      scheduler?.close();
      assertFileSearchDbPath(handle.path);
      db.close();
    },
  };
  if (runningOnOpen || !scanOnOpen) buildScannerStatus();
  else handle.scanAndIndex({ trigger: 'open' });
  return handle;
}
