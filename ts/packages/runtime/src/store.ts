import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MemoryIdentity, MemoryRecord, MemoryScope, WriteIntent } from './contracts.js';
import { normalizeRecord, normalizeWriteIntent } from './normalizers.js';
import { normalizeIdentity, normalizeStableKey } from './identity.js';
import { openSqliteSidecar, type SqliteSidecar } from './sqlite-sidecar.js';

export interface NativeStoreOptions {
  baseDir: string;
  storeFile?: string;
  sidecarFile?: string;
  embeddingBaseUrl?: string;
  embeddingModel?: string;
  embeddingDimension?: number;
  embeddingTimeoutMs?: number;
}

export interface NativeStore {
  write(intent: WriteIntent): Promise<MemoryRecord>;
  read(id: string): MemoryRecord | undefined;
  list(): MemoryRecord[];
  prune(id: string): MemoryRecord | undefined;
  close(): void;
  sidecar?: SqliteSidecar;
}

interface StoreSnapshot {
  version: 1;
  records: MemoryRecord[];
}

function stableIdFromIntent(intent: WriteIntent): string {
  const normalized = normalizeWriteIntent(intent);
  return normalizeStableKey(normalized.scope, normalized.identity);
}

function buildRecordId(identity: MemoryIdentity, scope: MemoryScope): string {
  return normalizeStableKey(scope, identity);
}

function loadSnapshot(filePath: string): StoreSnapshot {
  if (!existsSync(filePath)) return { version: 1, records: [] };
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { records?: unknown }).records)) {
    throw new Error('Invalid native store snapshot');
  }
  return parsed as StoreSnapshot;
}

function persistSnapshot(filePath: string, snapshot: StoreSnapshot): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  renameSync(tempPath, filePath);
}

export function openNativeStore(options: NativeStoreOptions): NativeStore {
  const filePath = resolve(options.baseDir, options.storeFile ?? 'native-store.json');
  const sidecar = openSqliteSidecar(options);
  const snapshot = loadSnapshot(filePath);
  const recordsById = new Map<string, MemoryRecord>(snapshot.records.map((record) => [record.id, normalizeRecord(record)]));

  return {
    sidecar,
    async write(intent: WriteIntent): Promise<MemoryRecord> {
      const normalized = normalizeWriteIntent(intent);
      const id = stableIdFromIntent(normalized) || buildRecordId(normalized.identity, normalized.scope);
      const record: MemoryRecord = normalizeRecord({
        id,
        scope: normalized.scope,
        provenance: normalized.provenance ?? { source: 'native-store' },
        identity: normalizeIdentity(normalized.scope, normalized.identity),
        content: normalized.content,
        metadata: {
          createdAt: recordsById.get(id)?.metadata?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });
      recordsById.set(record.id, record);
      await sidecar.syncWrite(normalized);
      persistSnapshot(filePath, { version: 1, records: [...recordsById.values()] });
      return record;
    },
    read(id: string): MemoryRecord | undefined {
      return recordsById.get(id);
    },
    list(): MemoryRecord[] {
      return [...recordsById.values()];
    },
    prune(id: string): MemoryRecord | undefined {
      const removed = recordsById.get(id);
      if (!removed) return undefined;
      recordsById.delete(id);
      sidecar.syncPrune(id);
      persistSnapshot(filePath, { version: 1, records: [...recordsById.values()] });
      return removed;
    },
    close(): void {
      sidecar.close();
      persistSnapshot(filePath, { version: 1, records: [...recordsById.values()] });
    },
  };
}
