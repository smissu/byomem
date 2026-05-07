import Database from 'better-sqlite3';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MemoryRecord, WriteIntent } from './contracts.js';
import { normalizeIdentity, normalizeRecord } from './normalizers.js';
import { type SqliteSidecar } from './sqlite-sidecar.js';
import { openSqliteSidecarInternal } from './sqlite-sidecar-internal.js';
import { openFileSearchDb, type FileSearchDbHandle } from './file-search-db.js';
import type { FileSearchIndexStorageMode } from './file-search-semble.js';


export interface NativeStoreOptions {
  baseDir: string;
  storeFile?: string;
  sidecarFile?: string;
  embeddingBaseUrl?: string;
  embeddingModel?: string;
  embeddingDimension?: number;
  embeddingTimeoutMs?: number;
  embeddingRequireRemote?: boolean;
  fileSearchSemanticEnabled?: boolean;
  fileSearchEmbeddingBatchSize?: number;
  fileSearchEmbeddingConcurrency?: number;
  fileSearchScanOnOpen?: boolean;
  fileSearchProjectBaseDir?: string;
  fileSearchDbFile?: string;
  fileSearchDbBaseDir?: string;
  fileSearchSchedulerEnabled?: boolean;
  fileSearchScannerExcludedExtensions?: string[];
  fileSearchBinaryDetectionEnabled?: boolean;
  fileSearchIncludeTextFiles?: boolean;
  fileSearchIndexStorageMode?: FileSearchIndexStorageMode;
}

export const storeKey = Symbol.for('byomem.runtime.nativeStore.singleWriter');

export interface NativeStore {
  baseDir: string;
  write(intent: WriteIntent): Promise<MemoryRecord>;
  read(id: string): MemoryRecord | undefined;
  list(): MemoryRecord[];
  prune(id: string): MemoryRecord | undefined;
  close(): void;
  sidecar?: SqliteSidecar;
  fileSearchDb?: FileSearchDbHandle;
  fileSearchProjectBaseDir?: string;
  [storeKey]?: true;
}

interface StoreSnapshot {
  version: 1;
  records: MemoryRecord[];
}

export type NativeStoreRepairAuthority = 'sqlite' | 'json' | 'abort';

export interface NativeStoreConflictSide {
  ids: string[];
  count: number;
}

export interface NativeStoreConflictInspection {
  jsonPath: string;
  memoryDbPath: string;
  jsonCount: number;
  sqliteCount: number;
  identical: NativeStoreConflictSide;
  differing: NativeStoreConflictSide;
  jsonOnly: NativeStoreConflictSide;
  sqliteOnly: NativeStoreConflictSide;
}

export interface NativeStoreRepairResult {
  inspection: NativeStoreConflictInspection;
  authority: NativeStoreRepairAuthority;
  dryRun: boolean;
  applied: boolean;
  backupPath?: string;
  importedCount?: number;
  removedCount?: number;
  aborted?: boolean;
}

function loadSnapshot(filePath: string): StoreSnapshot {
  if (!existsSync(filePath)) return { version: 1, records: [] };
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { records?: unknown }).records)) {
    throw new Error('Invalid native store snapshot');
  }
  return parsed as StoreSnapshot;
}

function comparableRecord(record: MemoryRecord): unknown {
  const normalized = normalizeRecord(record);
  const structured = normalized.content.structured && Object.keys(normalized.content.structured).length > 0 ? normalized.content.structured : undefined;
  return {
    id: normalized.id,
    scope: normalized.scope,
    identity: normalized.identity,
    provenance: normalized.provenance,
    content: {
      ...(normalized.content.text !== undefined ? { text: normalized.content.text } : {}),
      ...(structured ? { structured } : {}),
    },
    metadata: normalized.metadata,
  };
}

function loadSqliteRecord(row: {
  id: string;
  scope: string;
  namespace: string;
  leaf_name: string;
  parent_context: string;
  provenance_source: string;
  provenance_timestamp: string | null;
  provenance_adapter: string | null;
  provenance_origin: string | null;
  content_text: string | null;
  content_structured: string | null;
  created_at: string;
  updated_at: string;
}): MemoryRecord {
  return normalizeRecord({
    id: row.id,
    scope: row.scope as MemoryRecord['scope'],
    identity: normalizeIdentity({
      namespace: row.namespace,
      leafName: row.leaf_name,
      parentContext: row.parent_context,
    }),
    provenance: {
      source: row.provenance_source,
      timestamp: row.provenance_timestamp ?? undefined,
      adapter: row.provenance_adapter ?? undefined,
      origin: row.provenance_origin ?? undefined,
    },
    content: {
      text: row.content_text ?? undefined,
      structured: row.content_structured ? JSON.parse(row.content_structured) : undefined,
    },
    metadata: {
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  });
}

function loadSqliteRecords(filePath: string): MemoryRecord[] {
  if (!existsSync(filePath)) return [];
  const db = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const hasRecordsTable = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'records'`).get() as { name?: string } | undefined;
    if (!hasRecordsTable) return [];
    const rows = db.prepare('SELECT * FROM records ORDER BY id').all() as Array<{
      id: string;
      scope: string;
      namespace: string;
      leaf_name: string;
      parent_context: string;
      provenance_source: string;
      provenance_timestamp: string | null;
      provenance_adapter: string | null;
      provenance_origin: string | null;
      content_text: string | null;
      content_structured: string | null;
      created_at: string;
      updated_at: string;
    }>;
    return rows.map((row) => loadSqliteRecord(row));
  } finally {
    db.close();
  }
}

function compareRecordSets(jsonRecords: MemoryRecord[], sqliteRecords: MemoryRecord[]): NativeStoreConflictInspection {
  const byId = (records: MemoryRecord[]): Map<string, MemoryRecord> => new Map(records.map((record) => [record.id, record]));
  const jsonById = byId(jsonRecords);
  const sqliteById = byId(sqliteRecords);
  const ids = [...new Set([...jsonById.keys(), ...sqliteById.keys()])].sort((left, right) => left.localeCompare(right));
  const identical: string[] = [];
  const differing: string[] = [];
  const jsonOnly: string[] = [];
  const sqliteOnly: string[] = [];

  for (const id of ids) {
    const jsonRecord = jsonById.get(id);
    const sqliteRecord = sqliteById.get(id);
    if (jsonRecord && sqliteRecord) {
      if (JSON.stringify(comparableRecord(jsonRecord)) === JSON.stringify(comparableRecord(sqliteRecord))) identical.push(id);
      else differing.push(id);
    } else if (jsonRecord) {
      jsonOnly.push(id);
    } else if (sqliteRecord) {
      sqliteOnly.push(id);
    }
  }

  return {
    jsonPath: '',
    memoryDbPath: '',
    jsonCount: jsonRecords.length,
    sqliteCount: sqliteRecords.length,
    identical: { ids: identical, count: identical.length },
    differing: { ids: differing, count: differing.length },
    jsonOnly: { ids: jsonOnly, count: jsonOnly.length },
    sqliteOnly: { ids: sqliteOnly, count: sqliteOnly.length },
  };
}

function resolveNativeStoreJsonPath(options: NativeStoreOptions): string {
  return resolve(options.baseDir, options.storeFile ?? 'native-store.json');
}

function resolveNativeStoreMemoryDbPath(options: NativeStoreOptions): string {
  return resolve(options.baseDir, 'byomem-index.sqlite');
}

function buildTimestampBackupPath(filePath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let candidate = `${filePath}.backup-${stamp}`;
  let suffix = 1;
  while (existsSync(candidate)) {
    candidate = `${filePath}.backup-${stamp}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function loadConflictInspection(options: NativeStoreOptions): NativeStoreConflictInspection {
  const jsonPath = resolveNativeStoreJsonPath(options);
  const memoryDbPath = resolveNativeStoreMemoryDbPath(options);
  const inspection = compareRecordSets(
    loadSnapshot(jsonPath).records.map((record) => normalizeRecord(record)),
    loadSqliteRecords(memoryDbPath),
  );
  return { ...inspection, jsonPath, memoryDbPath };
}

export function inspectNativeStoreConflict(options: NativeStoreOptions): NativeStoreConflictInspection {
  return loadConflictInspection(options);
}

function renameIfExists(filePath: string, backupPath?: string): string | undefined {
  if (!existsSync(filePath)) return undefined;
  const resolvedBackupPath = backupPath ?? buildTimestampBackupPath(filePath);
  renameSync(filePath, resolvedBackupPath);
  return resolvedBackupPath;
}

export function repairNativeStoreConflict(options: NativeStoreOptions & { authority: NativeStoreRepairAuthority; dryRun?: boolean }): NativeStoreRepairResult {
  const inspection = loadConflictInspection(options);
  const dryRun = options.dryRun ?? false;
  const authority = options.authority;
  if (authority !== 'abort' && authority !== 'sqlite' && authority !== 'json') {
    throw new Error(`Invalid native-store repair authority: ${String(authority)}`);
  }
  const jsonPath = inspection.jsonPath;
  const jsonExists = existsSync(jsonPath);
  const backupPath = jsonExists ? buildTimestampBackupPath(jsonPath) : undefined;

  if (authority === 'abort') {
    return { inspection, authority, dryRun, applied: false, aborted: true };
  }

  if (dryRun) {
    return {
      inspection,
      authority,
      dryRun: true,
      applied: false,
      ...(backupPath ? { backupPath } : {}),
      ...(authority === 'json' ? { importedCount: inspection.jsonCount, removedCount: inspection.sqliteCount } : {}),
    };
  }

  if (authority === 'sqlite') {
    const movedPath = renameIfExists(jsonPath, backupPath);
    return {
      inspection,
      authority,
      dryRun: false,
      applied: Boolean(movedPath),
      ...(movedPath ? { backupPath: movedPath } : {}),
    };
  }

  if (!jsonExists) {
    throw new Error('Missing native-store.json for json authority repair');
  }

  const snapshot = loadSnapshot(jsonPath).records.map((record) => normalizeRecord(record));
  const { sidecar, mutator } = openSqliteSidecarInternal(options);
  const sidecarOwner = Object.freeze({ kind: 'native-store' as const });
  try {
    mutator.syncReplace(snapshot, sidecarOwner);
    const movedPath = renameIfExists(jsonPath, backupPath);
    return {
      inspection,
      authority,
      dryRun: false,
      applied: true,
      backupPath: movedPath,
      importedCount: snapshot.length,
      removedCount: inspection.sqliteCount,
    };
  } catch (error) {
    throw error;
  } finally {
    sidecar.close();
  }
}

function renameLegacySnapshot(filePath: string): void {
  let backupPath = `${filePath}.migrated`;
  if (existsSync(backupPath)) backupPath = `${backupPath}.${Date.now()}`;
  renameSync(filePath, backupPath);
}

export function openNativeStore(options: NativeStoreOptions): NativeStore {
  const filePath = resolveNativeStoreJsonPath(options);
  const { sidecar, mutator: sidecarMutator } = openSqliteSidecarInternal(options);
  const fileSearchDb = openFileSearchDb({
    baseDir: options.fileSearchProjectBaseDir ?? options.baseDir,
    projectBaseDir: options.fileSearchProjectBaseDir ?? options.baseDir,
    dbFile: options.fileSearchDbFile,
    dbBaseDir: options.fileSearchDbBaseDir,
    embeddingBaseUrl: options.embeddingBaseUrl,
    embeddingModel: options.embeddingModel,
    embeddingDimension: options.embeddingDimension,
    embeddingTimeoutMs: options.embeddingTimeoutMs,
    embeddingRequireRemote: options.embeddingRequireRemote,
    semanticSearchEnabled: options.fileSearchSemanticEnabled,
    embeddingBatchSize: options.fileSearchEmbeddingBatchSize,
    embeddingConcurrency: options.fileSearchEmbeddingConcurrency,
    scanOnOpen: options.fileSearchScanOnOpen,
    schedulerEnabled: options.fileSearchSchedulerEnabled,
    scannerExcludedExtensions: options.fileSearchScannerExcludedExtensions,
    scannerBinaryDetectionEnabled: options.fileSearchBinaryDetectionEnabled,
    scannerIncludeTextFiles: options.fileSearchIncludeTextFiles,
    storageMode: options.fileSearchIndexStorageMode,
  });
  const sidecarOwner = Object.freeze({ kind: 'native-store' as const });
  try {
    if (existsSync(filePath)) {
      const legacyRecords = loadSnapshot(filePath).records.map((record) => normalizeRecord(record));
      const sqliteRecords = sidecar.list();
      const comparison = compareRecordSets(legacyRecords, sqliteRecords);
      if (sqliteRecords.length === 0) {
        sidecarMutator.syncImport(legacyRecords, sidecarOwner);
        renameLegacySnapshot(filePath);
      } else if (comparison.differing.count === 0 && comparison.jsonOnly.count === 0 && comparison.sqliteOnly.count === 0) {
        renameLegacySnapshot(filePath);
      } else {
        throw new Error('Native store migration conflict: native-store.json differs from SQLite memory records');
      }
    }
  } catch (error) {
    fileSearchDb.close();
    sidecar.close();
    throw error;
  }

  return {
    baseDir: options.baseDir,
    sidecar,
    fileSearchDb,
    fileSearchProjectBaseDir: resolve(options.fileSearchProjectBaseDir ?? options.baseDir),
    [storeKey]: true,
    async write(intent: WriteIntent): Promise<MemoryRecord> {
      return await sidecarMutator.syncWrite(intent, sidecarOwner);
    },
    read(id: string): MemoryRecord | undefined {
      return sidecar.read(id);
    },
    list(): MemoryRecord[] {
      return sidecar.list();
    },
    prune(id: string): MemoryRecord | undefined {
      return sidecarMutator.syncPrune(id, sidecarOwner);
    },
    close(): void {
      fileSearchDb.close();
      sidecar.close();
    },
  };
}
