import { existsSync, readFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MemoryRecord, WriteIntent } from './contracts.js';
import { normalizeRecord } from './normalizers.js';
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
  return {
    id: normalized.id,
    scope: normalized.scope,
    identity: normalized.identity,
    provenance: normalized.provenance,
    content: normalized.content,
    metadata: normalized.metadata,
  };
}

function recordsMatch(left: MemoryRecord[], right: MemoryRecord[]): boolean {
  if (left.length !== right.length) return false;
  const rightById = new Map(right.map((record) => [record.id, comparableRecord(record)]));
  for (const record of left) {
    const expected = rightById.get(record.id);
    if (!expected || JSON.stringify(comparableRecord(record)) !== JSON.stringify(expected)) return false;
  }
  return true;
}

function renameLegacySnapshot(filePath: string): void {
  let backupPath = `${filePath}.migrated`;
  if (existsSync(backupPath)) backupPath = `${backupPath}.${Date.now()}`;
  renameSync(filePath, backupPath);
}

export function openNativeStore(options: NativeStoreOptions): NativeStore {
  const filePath = resolve(options.baseDir, options.storeFile ?? 'native-store.json');
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
      if (sqliteRecords.length === 0) {
        sidecarMutator.syncImport(legacyRecords, sidecarOwner);
        renameLegacySnapshot(filePath);
      } else if (recordsMatch(sqliteRecords, legacyRecords)) {
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
