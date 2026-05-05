import Database from 'better-sqlite3';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve, relative, sep, join, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { resolveProjectContext } from './project-context.js';
import { FileIndexScheduler } from './file-index-scheduler.js';
import { FILE_SEARCH_EMBEDDING_IDENTITY_VERSION, openEmbeddingClient, resolveEmbeddingProviderKey, SEMBLE_EMBEDDING_MODEL, type EmbeddingClient } from './embedding-client.js';
import { DEFAULT_EMBEDDING_DIMENSION, encodeEmbedding, truncateEmbeddingText } from './embedding-vector.js';
import { ensureFileSearchProjectRegistrySchema, getFileSearchProject, markFileSearchProjectSeen, serializeFileSearchPollingStatus } from './file-search-project-registry.js';
import { chunkFileContent, inferFileSearchLanguage, type FileSearchChunk, type FileSearchIndexStorageMode } from './file-search-semble.js';

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
  embeddingConcurrency?: number;
  scanOnOpen?: boolean;
  schedulerEnabled?: boolean;
  scannerStaleAfterMs?: number;
  scannerExcludedExtensions?: string[];
  scannerBinaryDetectionEnabled?: boolean;
  scannerIncludeTextFiles?: boolean;
  storageMode?: FileSearchIndexStorageMode;
}

export interface FileSearchEmbeddingDiagnostics {
  enabled: boolean;
  state: 'disabled' | 'ready' | 'refresh-needed' | 'incompatible';
  projectKey: string;
  baseDir: string;
  baseUrl?: string;
  providerKey: string;
  requireRemote: boolean;
  model: string;
  configuredDimension: number;
  actualDimensions: Array<{ dimension: number; chunks: number }>;
  indexedChunks: number;
  embeddedChunks: number;
  missingChunks: number;
  incompatibleChunks: number;
  refreshNeededChunks: number;
  failedChunks: number;
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
  readonly indexRevision: number;
  close(): void;
  scanAndIndex(options?: { trigger?: FileSearchScannerTrigger }): FileSearchScannerStatus;
  getScannerStatus(): FileSearchScannerStatus;
  refreshSemanticIndex(options?: { limit?: number; concurrency?: number }): Promise<FileSearchEmbeddingDiagnostics>;
  getEmbeddingDiagnostics(): FileSearchEmbeddingDiagnostics;
  embedQuery(text: string): Promise<number[] | undefined>;
  semanticSearchEnabled: boolean;
  embeddingModel: string;
  embeddingConfiguredDimension: number;
  embeddingProviderKey: string;
  scheduleRefresh(event: FileSearchRefreshEvent): void;
  flushScheduledRefreshes(): void;
  refreshMetrics: { runs: number; failures: number; skips: number; retries: number; lastRunAt?: string; lastFailureAt?: string };
}

const DEFAULT_FILE_SEARCH_DB_FILE = 'byomem-file-search.sqlite';
const IGNORED_DIRS = new Set(['node_modules', '.git']);
const ROOT_RUNTIME_IGNORED_DIRS = new Set(['queue', '.byomem']);
const IGNORED_BASENAMES = new Set(['byomem-index.sqlite', 'byomem-file-search.sqlite', 'native-store.json', 'queue.json', 'worker.json', 'session-capture-state.json', 'byomem-turn-end.jsonl']);
const SENSITIVE_CONTENT_MARKERS = ['thinkingSignature', 'textSignature', 'encrypted_content', 'encryptedContent'];
const SENSITIVE_CONTENT_FIELD_RE = new RegExp(
  String.raw`(?:^|[{\[,])\s*["'](?:${SENSITIVE_CONTENT_MARKERS.join('|')})["']\s*:\s*(?:["']|[{[]|true\b|false\b|null\b|-?\d)`,
);
const MAX_ACTIVE_PROJECTS = 3;
const DEBOUNCE_WINDOW_MS = 250;
const BACKSTOP_WINDOW_MS = 60_000;
const DEFAULT_EMBEDDING_MODEL = 'minishlab/potion-code-16M';
const DEFAULT_SCANNER_STALE_AFTER_MS = 5 * 60_000;

function isSQLiteCompanion(filePath: string): boolean {
  return /-(wal|shm)$/.test(filePath);
}

const DEFAULT_SCANNER_EXCLUDED_EXTENSIONS = ['.db', '.sqlite', '.sqlite3'];
const SCANNER_BINARY_SAMPLE_BYTES = 4096;
const SCANNER_BINARY_CONTROL_RATIO = 0.3;

function normalizeScannerExcludedExtension(extension: string): string | undefined {
  const trimmed = extension.trim().toLowerCase();
  if (!trimmed) return undefined;
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

function resolveScannerExcludedExtensions(options: FileSearchDbOptions): Set<string> {
  const configured = options.scannerExcludedExtensions;
  const raw = configured === undefined ? DEFAULT_SCANNER_EXCLUDED_EXTENSIONS : configured;
  return new Set(raw.map((extension) => normalizeScannerExcludedExtension(extension)).filter((extension): extension is string => Boolean(extension)));
}

function matchesScannerExcludedExtension(filePath: string, extensions: Set<string>): boolean {
  if (!extensions.size) return false;
  const name = basename(filePath).toLowerCase();
  for (const extension of extensions) {
    if (name.endsWith(extension)) return true;
  }
  return false;
}

function readFileSample(filePath: string, sampleSize = SCANNER_BINARY_SAMPLE_BYTES): Buffer {
  const handle = openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(sampleSize);
    const bytesRead = readSync(handle, buffer, 0, sampleSize, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(handle);
  }
}

function isLikelyBinaryFile(filePath: string): boolean {
  const sample = readFileSample(filePath);
  if (sample.length === 0) return false;
  if (sample.includes(0)) return true;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 12 || byte === 13) continue;
    if (byte < 32) suspicious += 1;
  }
  return suspicious / sample.length > SCANNER_BINARY_CONTROL_RATIO;
}

export function isIgnoredFileSearchArtifact(filePath: string, baseDir?: string): boolean {
  const name = basename(filePath);
  if (IGNORED_BASENAMES.has(name) || isSQLiteCompanion(name)) return true;
  const normalized = baseDir ? normalizePathForGitignore(relative(baseDir, filePath)) : normalizePathForGitignore(filePath);
  const rootSegment = normalized.split('/')[0];
  return ROOT_RUNTIME_IGNORED_DIRS.has(rootSegment);
}

export function containsSensitiveFileSearchContent(content: string): boolean {
  return SENSITIVE_CONTENT_FIELD_RE.test(content);
}

function isIgnoredInternalFile(filePath: string, baseDir?: string): boolean {
  return isIgnoredFileSearchArtifact(filePath, baseDir);
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
  if ((options.storageMode ?? 'disk') === 'memory') return ':memory:';
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
  if (path === ':memory:') return;
  const canonical = resolve(path);
  const fileName = canonical.split(/[/\\]/).pop() ?? canonical;
  if (fileName === 'byomem-index.sqlite' || fileName === 'native-store.json') {
    throw new Error('file search DB must not target the memories DB path');
  }
}


function ensureColumn(db: BetterSqliteDatabase, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column)) db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}

function ensureFoundationSchema(db: BetterSqliteDatabase, storageMode: FileSearchIndexStorageMode = 'disk'): void {
  db.pragma(storageMode === 'memory' ? 'journal_mode = MEMORY' : 'journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS file_search_index_revisions (
      project_key TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
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
      search_text TEXT NOT NULL,
      chunk_hash TEXT NOT NULL,
      start_line INTEGER,
      end_line INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(file_record_id) REFERENCES file_records(id) ON DELETE CASCADE
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS indexed_chunks_fts USING fts5(id UNINDEXED, project_key UNINDEXED, file_record_id UNINDEXED, chunk_index UNINDEXED, chunk_text, chunk_hash, content='indexed_chunks', content_rowid='rowid', tokenize = 'unicode61');
    CREATE TRIGGER IF NOT EXISTS indexed_chunks_ai AFTER INSERT ON indexed_chunks BEGIN
      INSERT INTO indexed_chunks_fts(rowid, id, project_key, file_record_id, chunk_index, chunk_text, chunk_hash) VALUES (new.rowid, new.id, new.project_key, new.file_record_id, new.chunk_index, new.search_text, new.chunk_hash);
    END;
    CREATE TRIGGER IF NOT EXISTS indexed_chunks_ad AFTER DELETE ON indexed_chunks BEGIN
      INSERT INTO indexed_chunks_fts(indexed_chunks_fts, rowid, id, project_key, file_record_id, chunk_index, chunk_text, chunk_hash) VALUES('delete', old.rowid, old.id, old.project_key, old.file_record_id, old.chunk_index, old.search_text, old.chunk_hash);
    END;
    CREATE TRIGGER IF NOT EXISTS indexed_chunks_au AFTER UPDATE ON indexed_chunks BEGIN
      INSERT INTO indexed_chunks_fts(indexed_chunks_fts, rowid, id, project_key, file_record_id, chunk_index, chunk_text, chunk_hash) VALUES('delete', old.rowid, old.id, old.project_key, old.file_record_id, old.chunk_index, old.search_text, old.chunk_hash);
      INSERT INTO indexed_chunks_fts(rowid, id, project_key, file_record_id, chunk_index, chunk_text, chunk_hash) VALUES (new.rowid, new.id, new.project_key, new.file_record_id, new.chunk_index, new.search_text, new.chunk_hash);
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
      provider_key TEXT,
      effective_dimension INTEGER,
      cache_version TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_file_embedding_cache_lookup ON file_embedding_cache(text_hash, model, configured_dimension, provider_key, effective_dimension, cache_version);
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
      provider_key TEXT,
      effective_dimension INTEGER,
      identity_version TEXT,
      status TEXT NOT NULL DEFAULT 'ready',
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(chunk_id) REFERENCES indexed_chunks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_indexed_chunk_embeddings_project_key ON indexed_chunk_embeddings(project_key);
    CREATE INDEX IF NOT EXISTS idx_indexed_chunk_embeddings_model ON indexed_chunk_embeddings(model, configured_dimension, status);
  `);
  ensureColumn(db, 'indexed_chunks', 'start_line', 'INTEGER');
  ensureColumn(db, 'indexed_chunks', 'end_line', 'INTEGER');
  ensureColumn(db, 'indexed_chunks', 'search_text', 'TEXT');
  ensureColumn(db, 'file_embedding_cache', 'provider_key', 'TEXT');
  ensureColumn(db, 'file_embedding_cache', 'effective_dimension', 'INTEGER');
  ensureColumn(db, 'file_embedding_cache', 'cache_version', 'TEXT');
  ensureColumn(db, 'indexed_chunk_embeddings', 'provider_key', 'TEXT');
  ensureColumn(db, 'indexed_chunk_embeddings', 'effective_dimension', 'INTEGER');
  ensureColumn(db, 'indexed_chunk_embeddings', 'identity_version', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_indexed_chunk_embeddings_identity ON indexed_chunk_embeddings(project_key, provider_key, model, configured_dimension, status, chunk_hash)');
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

function readFileSearchIndexRevision(db: BetterSqliteDatabase, projectKey: string): number {
  const row = db.prepare('SELECT revision FROM file_search_index_revisions WHERE project_key = ?').get(projectKey) as { revision?: number } | undefined;
  return typeof row?.revision === 'number' ? row.revision : 0;
}

function bumpFileSearchIndexRevision(db: BetterSqliteDatabase, projectKey: string): number {
  const now = new Date().toISOString();
  const current = readFileSearchIndexRevision(db, projectKey);
  const next = current + 1;
  db.prepare(`
    INSERT INTO file_search_index_revisions (project_key, revision, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(project_key) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at
  `).run(projectKey, next, now);
  return next;
}

function buildFileSearchLexicalText(rel: string, content: string): string {
  const normalized = rel.replace(/\\/g, '/');
  const parts = normalized.split('/').filter((part) => part && part !== '.');
  const stem = basename(normalized).replace(/\.[^.]+$/, '').toLowerCase();
  const dirText = parts.slice(0, -1).slice(-3).join(' ').toLowerCase();
  return `${content} ${stem} ${stem} ${dirText}`.trim();
}

type IndexedChunkSnapshotRow = {
  id: string;
  chunk_index: number;
  chunk_text: string;
  search_text: string;
  chunk_hash: string;
};

function canBackfillIndexedChunkLineMetadata(existingChunks: IndexedChunkSnapshotRow[], chunks: FileSearchChunk[], rel: string): boolean {
  return existingChunks.length === chunks.length && existingChunks.every((row, index) => {
    const chunk = chunks[index];
    return chunk !== undefined
      && row.chunk_index === index
      && row.chunk_text === chunk.content
      && row.search_text === buildFileSearchLexicalText(rel, chunk.content)
      && row.chunk_hash === hashContent(chunk.content);
  });
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
        if (!IGNORED_DIRS.has(entry.name) && !isIgnoredInternalFile(fullPath, rootDir) && !isGitignored(gitignoreRules, relativePath, true)) queue.push({ dir: fullPath, rules: gitignoreRules });
        else ignoredFiles += 1;
        continue;
      }
      if (!entry.isFile()) continue;
      if (isIgnoredInternalFile(fullPath, rootDir) || isGitignored(gitignoreRules, relativePath, false)) {
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
  return { indexedFiles: indexedFiles.count, indexedChunks: indexedChunks.count, changedRows: changedRows.count, reconciledRows: reconciledRows.count };
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
  const contentAndMetadataMatch = Boolean(current && current.content_hash === contentHash && current.mtime_ms === stats.mtimeMs && current.size_bytes === stats.size);
  const chunks = chunkFileContent(filePath, content);
  const missingLineMetadata = contentAndMetadataMatch
    ? ((db.prepare('SELECT COUNT(*) AS count FROM indexed_chunks WHERE file_record_id = ? AND (start_line IS NULL OR end_line IS NULL)').get(recordId) as { count: number }).count > 0)
    : false;
  const existingChunks = contentAndMetadataMatch
    ? db.prepare('SELECT id, chunk_index, chunk_text, search_text, chunk_hash FROM indexed_chunks WHERE file_record_id = ? ORDER BY chunk_index').all(recordId) as IndexedChunkSnapshotRow[]
    : [];
  const missingSearchText = contentAndMetadataMatch
    ? existingChunks.some((row, index) => row.search_text !== buildFileSearchLexicalText(rel, chunks[index]?.content ?? row.chunk_text))
    : false;

  if (contentAndMetadataMatch && !missingLineMetadata && !missingSearchText) return { changed: false, chunksWritten: 0 };

  if (contentAndMetadataMatch && (missingLineMetadata || missingSearchText)) {
    if (canBackfillIndexedChunkLineMetadata(existingChunks, chunks, rel)) {
      db.prepare('UPDATE file_records SET path = ?, content_hash = ?, mtime_ms = ?, size_bytes = ?, updated_at = ? WHERE id = ?').run(
        filePath,
        contentHash,
        stats.mtimeMs,
        stats.size,
        now,
        recordId,
      );
      db.prepare('UPDATE indexed_files SET path = ?, file_record_id = ?, updated_at = ? WHERE id = ?').run(
        filePath,
        recordId,
        now,
        `indexed-file:${projectKey}:${rel}`,
      );
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
      const updateChunkLineMetadata = db.prepare('UPDATE indexed_chunks SET start_line = ?, end_line = ?, updated_at = ? WHERE id = ?');
      existingChunks.forEach((row, chunkIndex) => {
        const chunk = chunks[chunkIndex]!;
        updateChunkLineMetadata.run(chunk.startLine, chunk.endLine, now, row.id);
      });
      if (missingSearchText) {
        const updateChunkSearchText = db.prepare('UPDATE indexed_chunks SET search_text = ?, updated_at = ? WHERE id = ?');
        existingChunks.forEach((row, chunkIndex) => {
          const chunk = chunks[chunkIndex]!;
          updateChunkSearchText.run(buildFileSearchLexicalText(rel, chunk.content), now, row.id);
        });
      }
      return { changed: true, chunksWritten: chunks.length };
    }
  }

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
  chunks.forEach((chunk, chunkIndex) => {
    upsertRow(db, 'INSERT OR REPLACE INTO indexed_chunks (id, project_key, file_record_id, chunk_index, chunk_text, search_text, chunk_hash, start_line, end_line, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      `indexed-chunk:${projectKey}:${rel}:${chunkIndex}`,
      projectKey,
      recordId,
      chunkIndex,
      chunk.content,
      buildFileSearchLexicalText(rel, chunk.content),
      hashContent(chunk.content),
      chunk.startLine,
      chunk.endLine,
      now,
      now,
    ]);
  });
  return { changed: true, chunksWritten: chunks.length };
}

function scanAndIndexFiles(db: BetterSqliteDatabase, baseDir: string, progress: FileSearchScannerProgress, options: FileSearchDbOptions, onProgress?: (currentPath?: string, lastPath?: string) => void): { lastPath?: string } {
  const projectKey = deriveProjectKey(baseDir);
  const now = new Date().toISOString();
  const walked = walkFiles(baseDir);
  const files = walked.files.filter((filePath) => !isIgnoredInternalFile(filePath, baseDir));
  const seen = new Set<string>();
  const excludedExtensions = resolveScannerExcludedExtensions(options);
  const binaryDetectionEnabled = options.scannerBinaryDetectionEnabled ?? true;
  const includeTextFiles = Boolean(options.scannerIncludeTextFiles);
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
      const stats = statSync(filePath);
      const prefilterId = `prefilter:${projectKey}:${rel}`;
      if (matchesScannerExcludedExtension(filePath, excludedExtensions)) {
        progress.ignoredFiles += 1;
        progress.filesRemaining = Math.max(0, (progress.filesRemaining ?? 0) - 1);
        onProgress?.(rel, lastPath);
        continue;
      }
      if (!includeTextFiles && inferFileSearchLanguage(filePath) === undefined) {
        progress.ignoredFiles += 1;
        progress.filesRemaining = Math.max(0, (progress.filesRemaining ?? 0) - 1);
        onProgress?.(rel, lastPath);
        continue;
      }
      if (binaryDetectionEnabled && isLikelyBinaryFile(filePath)) {
        progress.ignoredFiles += 1;
        progress.filesRemaining = Math.max(0, (progress.filesRemaining ?? 0) - 1);
        onProgress?.(rel, lastPath);
        continue;
      }
      const content = readFileSync(filePath, 'utf8');
      progress.bytesRead = (progress.bytesRead ?? 0) + Buffer.byteLength(content, 'utf8');
      if (containsSensitiveFileSearchContent(content)) {
        progress.ignoredFiles += 1;
        progress.filesRemaining = Math.max(0, (progress.filesRemaining ?? 0) - 1);
        onProgress?.(rel, lastPath);
        continue;
      }
      seen.add(rel);
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
  if (options.embeddingDimension !== undefined) return options.embeddingDimension;
  return embeddingModel(options) === SEMBLE_EMBEDDING_MODEL ? 256 : DEFAULT_EMBEDDING_DIMENSION;
}

function semanticEnabled(options: FileSearchDbOptions): boolean {
  return Boolean(options.semanticSearchEnabled ?? true);
}

function configuredDimensionCompatibleSql(alias: string): string {
  return `((${alias}.configured_dimension = ?) AND (? = 0 OR ${alias}.dimension = ?))`;
}

function cacheId(textHash: string, providerKey: string, model: string, configuredDimension: number, effectiveDimension: number): string {
  return [FILE_SEARCH_EMBEDDING_IDENTITY_VERSION, providerKey, model, configuredDimension, effectiveDimension, textHash].join(':');
}

function embeddingProviderKey(options: FileSearchDbOptions): string {
  return resolveEmbeddingProviderKey(options.embeddingBaseUrl, embeddingModel(options));
}

async function runConcurrent<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  shouldStop?: () => boolean,
): Promise<void> {
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      if (shouldStop?.()) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      if (shouldStop?.()) return;
      await worker(items[index]!, index);
    }
  }));
}

function embeddingDiagnostics(db: BetterSqliteDatabase, options: FileSearchDbOptions): FileSearchEmbeddingDiagnostics {
  const model = embeddingModel(options);
  const configuredDimension = embeddingConfiguredDimension(options);
  const projectKey = deriveProjectKey(resolveProjectBaseDir(options));
  const baseDir = resolveProjectBaseDir(options);
  const providerKey = embeddingProviderKey(options);
  const enabled = semanticEnabled(options);
  const indexed = db.prepare('SELECT COUNT(*) AS count FROM indexed_chunks WHERE project_key = ?').get(projectKey) as { count: number };
  const embedded = db.prepare(`
    SELECT COUNT(*) AS count
    FROM indexed_chunk_embeddings e
    JOIN indexed_chunks c ON c.id = e.chunk_id
    WHERE e.project_key = ? AND e.provider_key = ? AND e.model = ? AND ${configuredDimensionCompatibleSql('e')}
      AND e.status = 'ready' AND e.chunk_hash = c.chunk_hash AND e.identity_version = ?
  `).get(projectKey, providerKey, model, configuredDimension, configuredDimension, configuredDimension, FILE_SEARCH_EMBEDDING_IDENTITY_VERSION) as { count: number };
  const failed = db.prepare(`
    SELECT COUNT(*) AS count
    FROM indexed_chunk_embeddings e
    JOIN indexed_chunks c ON c.id = e.chunk_id
    WHERE e.project_key = ? AND e.provider_key = ? AND e.model = ? AND e.configured_dimension = ?
      AND e.status = 'failed' AND e.chunk_hash = c.chunk_hash AND e.identity_version = ?
  `).get(projectKey, providerKey, model, configuredDimension, FILE_SEARCH_EMBEDDING_IDENTITY_VERSION) as { count: number };
  const missing = db.prepare(`
    SELECT COUNT(*) AS count
    FROM indexed_chunks c
    WHERE c.project_key = ? AND NOT EXISTS (SELECT 1 FROM indexed_chunk_embeddings e WHERE e.chunk_id = c.id)
  `).get(projectKey) as { count: number };
  const incompatible = db.prepare(`
    SELECT COUNT(*) AS count
    FROM indexed_chunks c
    WHERE c.project_key = ?
      AND EXISTS (SELECT 1 FROM indexed_chunk_embeddings e WHERE e.chunk_id = c.id)
      AND NOT EXISTS (
        SELECT 1 FROM indexed_chunk_embeddings e
        WHERE e.chunk_id = c.id AND e.project_key = ? AND e.provider_key = ? AND e.model = ? AND ${configuredDimensionCompatibleSql('e')}
          AND e.status = 'ready' AND e.chunk_hash = c.chunk_hash AND e.identity_version = ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM indexed_chunk_embeddings e
        WHERE e.chunk_id = c.id AND e.project_key = ? AND e.provider_key = ? AND e.model = ? AND e.configured_dimension = ?
          AND e.status = 'failed' AND e.chunk_hash = c.chunk_hash AND e.identity_version = ?
      )
  `).get(projectKey, projectKey, providerKey, model, configuredDimension, configuredDimension, configuredDimension, FILE_SEARCH_EMBEDDING_IDENTITY_VERSION, projectKey, providerKey, model, configuredDimension, FILE_SEARCH_EMBEDDING_IDENTITY_VERSION) as { count: number };
  const dimensions = db.prepare(`
    SELECT e.dimension AS dimension, COUNT(*) AS chunks
    FROM indexed_chunk_embeddings e
    JOIN indexed_chunks c ON c.id = e.chunk_id
    WHERE e.project_key = ? AND e.status = 'ready' AND e.chunk_hash = c.chunk_hash
    GROUP BY e.dimension
    ORDER BY e.dimension ASC
  `).all(projectKey) as Array<{ dimension: number; chunks: number }>;
  const lastFailure = db.prepare(`
    SELECT error FROM indexed_chunk_embeddings
    WHERE project_key = ? AND provider_key = ? AND model = ? AND configured_dimension = ? AND status = 'failed' AND error IS NOT NULL
    ORDER BY updated_at DESC LIMIT 1
  `).get(projectKey, providerKey, model, configuredDimension) as { error?: string } | undefined;
  const failedChunks = failed.count;
  const refreshNeededChunks = missing.count + incompatible.count + failedChunks;
  const state: FileSearchEmbeddingDiagnostics['state'] = !enabled ? 'disabled' : incompatible.count > 0 ? 'incompatible' : refreshNeededChunks > 0 ? 'refresh-needed' : 'ready';
  const diagnostics: FileSearchEmbeddingDiagnostics = {
    enabled,
    state,
    projectKey,
    baseDir,
    baseUrl: options.embeddingBaseUrl,
    providerKey,
    requireRemote: Boolean(options.embeddingRequireRemote),
    model,
    configuredDimension,
    actualDimensions: dimensions.map((entry) => ({ dimension: entry.dimension, chunks: entry.chunks })),
    indexedChunks: indexed.count,
    embeddedChunks: embedded.count,
    missingChunks: missing.count,
    incompatibleChunks: incompatible.count,
    refreshNeededChunks,
    failedChunks,
    failures: failedChunks,
    fallbacks: 0,
  };
  if (lastFailure?.error) diagnostics.lastError = lastFailure.error;
  return diagnostics;
}

async function refreshSemanticIndex(db: BetterSqliteDatabase, options: FileSearchDbOptions, embeddingClient: EmbeddingClient, refreshOptions: { limit?: number; concurrency?: number } = {}): Promise<FileSearchEmbeddingDiagnostics> {
  if (!semanticEnabled(options)) return embeddingDiagnostics(db, options);
  const model = embeddingModel(options);
  const configuredDimension = embeddingConfiguredDimension(options);
  const projectKey = deriveProjectKey(resolveProjectBaseDir(options));
  const providerKey = embeddingProviderKey(options);
  const limit = Math.max(1, refreshOptions.limit ?? options.embeddingBatchSize ?? 100);
  const rows = db.prepare(`
    SELECT c.id, c.project_key, c.file_record_id, c.chunk_index, c.chunk_text, c.chunk_hash
    FROM indexed_chunks c
    WHERE c.project_key = ? AND NOT EXISTS (
      SELECT 1 FROM indexed_chunk_embeddings e
      WHERE e.chunk_id = c.id AND e.project_key = c.project_key AND e.provider_key = ? AND e.model = ? AND ${configuredDimensionCompatibleSql('e')}
        AND e.status = 'ready' AND e.chunk_hash = c.chunk_hash AND e.identity_version = ?
    )
    ORDER BY c.file_record_id, c.chunk_index
    LIMIT ?
  `).all(projectKey, providerKey, model, configuredDimension, configuredDimension, configuredDimension, FILE_SEARCH_EMBEDDING_IDENTITY_VERSION, limit) as Array<{ id: string; project_key: string; file_record_id: string; chunk_index: number; chunk_text: string; chunk_hash: string }>;
  const now = new Date().toISOString();
  const pending = rows.map((row) => {
    const embeddingText = truncateEmbeddingText(row.chunk_text);
    const textHash = embeddingClient.hashText(embeddingText);
    const lookupEffectiveDimension = configuredDimension || embeddingClient.configuredDimension || DEFAULT_EMBEDDING_DIMENSION;
    const id = cacheId(textHash, providerKey, model, configuredDimension, lookupEffectiveDimension);
    return { row, embeddingText, textHash, lookupEffectiveDimension, id };
  });
  const missing: typeof pending = [];
  for (const entry of pending) {
    const cached = db.prepare('SELECT embedding, dimension FROM file_embedding_cache WHERE id = ?').get(entry.id) as { embedding: Buffer; dimension: number } | undefined;
    if (!cached) missing.push(entry);
    else {
      const dimension = cached.dimension || entry.lookupEffectiveDimension || DEFAULT_EMBEDDING_DIMENSION;
      db.prepare(`INSERT OR REPLACE INTO indexed_chunk_embeddings (chunk_id, project_key, file_record_id, chunk_index, chunk_hash, text_hash, model, configured_dimension, embedding, dimension, provider_key, effective_dimension, identity_version, status, error, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', NULL, COALESCE((SELECT created_at FROM indexed_chunk_embeddings WHERE chunk_id = ?), ?), ?)`).run(entry.row.id, entry.row.project_key, entry.row.file_record_id, entry.row.chunk_index, entry.row.chunk_hash, entry.textHash, model, configuredDimension, cached.embedding, dimension, providerKey, dimension, FILE_SEARCH_EMBEDDING_IDENTITY_VERSION, entry.row.id, now, now);
    }
  }
  if (missing.length) {
    const batchSize = Math.max(1, Math.min(refreshOptions.concurrency ?? options.embeddingConcurrency ?? missing.length, missing.length));
    for (let start = 0; start < missing.length; start += batchSize) {
      const batch = missing.slice(start, start + batchSize);
      const vectors = await embeddingClient.embedMany(batch.map((entry) => entry.embeddingText));
      for (let index = 0; index < batch.length; index += 1) {
        const entry = batch[index]!;
        const vector = vectors[index];
        if (!vector?.length) {
          const message = options.embeddingRequireRemote ? `Remote embedding request returned no embedding for model ${model}` : 'Embedding request returned no vector';
          db.prepare(`INSERT OR REPLACE INTO indexed_chunk_embeddings (chunk_id, project_key, file_record_id, chunk_index, chunk_hash, text_hash, model, configured_dimension, embedding, dimension, provider_key, effective_dimension, identity_version, status, error, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?, COALESCE((SELECT created_at FROM indexed_chunk_embeddings WHERE chunk_id = ?), ?), ?)`).run(entry.row.id, entry.row.project_key, entry.row.file_record_id, entry.row.chunk_index, entry.row.chunk_hash, entry.textHash, model, configuredDimension, Buffer.alloc(0), 0, providerKey, 0, FILE_SEARCH_EMBEDDING_IDENTITY_VERSION, message, entry.row.id, now, now);
          if (options.embeddingRequireRemote) throw new Error(message);
          continue;
        }
        const embedding = encodeEmbedding(vector);
        const dimension = vector.length;
        const cacheIdValue = cacheId(entry.textHash, providerKey, model, configuredDimension, dimension);
        db.prepare('INSERT OR REPLACE INTO file_embedding_cache (id, text_hash, model, configured_dimension, embedding, dimension, provider_key, effective_dimension, cache_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(cacheIdValue, entry.textHash, model, configuredDimension, embedding, dimension, providerKey, dimension, FILE_SEARCH_EMBEDDING_IDENTITY_VERSION, now);
        db.prepare(`INSERT OR REPLACE INTO indexed_chunk_embeddings (chunk_id, project_key, file_record_id, chunk_index, chunk_hash, text_hash, model, configured_dimension, embedding, dimension, provider_key, effective_dimension, identity_version, status, error, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', NULL, COALESCE((SELECT created_at FROM indexed_chunk_embeddings WHERE chunk_id = ?), ?), ?)`).run(entry.row.id, entry.row.project_key, entry.row.file_record_id, entry.row.chunk_index, entry.row.chunk_hash, entry.textHash, model, configuredDimension, embedding, dimension, providerKey, dimension, FILE_SEARCH_EMBEDDING_IDENTITY_VERSION, entry.row.id, now, now);
      }
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
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  ensureFoundationSchema(db, options.storageMode ?? 'disk');
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
      const result = scanAndIndexFiles(db, projectBaseDir, progress, options, persistRunning);
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
  const runScanAndBumpRevision = (trigger: FileSearchScannerTrigger): FileSearchScannerStatus => {
    try {
      return runScan(trigger);
    } finally {
      bumpFileSearchIndexRevision(db, projectKey);
    }
  };
  const embeddingClient = openEmbeddingClient({
    baseUrl: options.embeddingBaseUrl,
    model: options.embeddingModel,
    dimension: embeddingConfiguredDimension(options),
    timeoutMs: options.embeddingTimeoutMs,
    requireRemote: options.embeddingRequireRemote,
  });
  const scheduler = schedulerEnabled
    ? new FileIndexScheduler({
        scanAndIndex: (scanOptions?: { trigger?: FileSearchScannerTrigger }) => runScanAndBumpRevision(scanOptions?.trigger ?? 'manual'),
      } as FileSearchDbHandle, projectBaseDir, { maxActiveProjects: MAX_ACTIVE_PROJECTS, debounceWindowMs: DEBOUNCE_WINDOW_MS, backstopWindowMs: BACKSTOP_WINDOW_MS })
    : undefined;

  const handle: FileSearchDbHandle = {
    path,
    db,
    get indexRevision(): number {
      return readFileSearchIndexRevision(db, projectKey);
    },
    semanticSearchEnabled: semanticEnabled(options),
    embeddingModel: embeddingModel(options),
    embeddingConfiguredDimension: embeddingConfiguredDimension(options),
    embeddingProviderKey: embeddingProviderKey(options),
    refreshMetrics: scheduler?.refreshMetrics ?? { runs: 0, failures: 0, skips: 0, retries: 0 },
    scanAndIndex(scanOptions?: { trigger?: FileSearchScannerTrigger }): FileSearchScannerStatus {
      const trigger = scanOptions?.trigger ?? 'manual';
      runScanAndBumpRevision(trigger);
      if (trigger === 'manual') markFileSearchProjectSeen(db, projectBaseDir, 'manual-scan');
      return buildScannerStatus();
    },
    getScannerStatus(): FileSearchScannerStatus {
      return buildScannerStatus();
    },
    async refreshSemanticIndex(refreshOptions?: { limit?: number; concurrency?: number }): Promise<FileSearchEmbeddingDiagnostics> {
      try {
        return await refreshSemanticIndex(db, options, embeddingClient, refreshOptions);
      } finally {
        bumpFileSearchIndexRevision(db, projectKey);
      }
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
      embeddingClient.close?.();
      assertFileSearchDbPath(handle.path);
      db.close();
    },
  };
  if (runningOnOpen || !scanOnOpen) buildScannerStatus();
  else handle.scanAndIndex({ trigger: 'open' });
  return handle;
}
