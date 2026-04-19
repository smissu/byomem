import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MemoryIdentity, MemoryRecord, MemoryScope, WriteIntent } from './contracts.js';
import { normalizeIdentity, normalizeStableKey } from './identity.js';
import { normalizeRecord, normalizeWriteIntent } from './normalizers.js';

export interface SharedCorpusOptions {
  baseDir: string;
  corpusDir?: string;
}

export interface SharedCorpusStore {
  write(intent: WriteIntent): MemoryRecord;
  read(id: string): MemoryRecord | undefined;
  list(): MemoryRecord[];
  prune(id: string): MemoryRecord | undefined;
  close(): void;
  path: string;
}

interface CorpusRow {
  id?: string;
  scope?: MemoryScope;
  lifecycle?: 'active' | 'deleted';
  identity?: Partial<MemoryIdentity>;
  content?: MemoryRecord['content'];
  provenance?: MemoryRecord['provenance'];
  metadata?: MemoryRecord['metadata'];
}

function resolveCorpusPath(options: SharedCorpusOptions): string {
  return resolve(options.baseDir, options.corpusDir ?? 'native');
}

function resolveCorpusFilePath(corpusPath: string): string {
  return resolve(corpusPath, 'records.jsonl');
}

function normalizeCorpusContent(content: CorpusRow['content']): MemoryRecord['content'] {
  if (typeof content === 'string') {
    return { text: content };
  }
  return content ?? {};
}

function parseRow(line: string): MemoryRecord | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  const parsed = JSON.parse(trimmed) as CorpusRow;
  if (parsed.lifecycle === 'deleted') return undefined;
  const scope = parsed.scope ?? 'project';
  const identity = normalizeIdentity(scope, {
    namespace: parsed.identity?.namespace ?? 'byomem',
    leafName: parsed.identity?.leafName ?? parsed.id ?? 'record',
    parentContext: parsed.identity?.parentContext,
    stableKey: parsed.identity?.stableKey,
  });
  const id = parsed.id ?? normalizeStableKey(scope, identity);
  return normalizeRecord({
    id,
    scope,
    identity,
    provenance: parsed.provenance ?? { source: 'shared-corpus', adapter: 'jsonl' },
    content: normalizeCorpusContent(parsed.content),
    metadata: parsed.metadata,
  });
}

function loadRecords(filePath: string): MemoryRecord[] {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map(parseRow)
    .filter((record): record is MemoryRecord => Boolean(record));
}

function persistRecords(filePath: string, records: MemoryRecord[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  const content = records.map((record) => JSON.stringify(record)).join('\n');
  writeFileSync(tempPath, `${content}${content ? '\n' : ''}`, 'utf8');
  renameSync(tempPath, filePath);
}

export function openSharedCorpusStore(options: SharedCorpusOptions): SharedCorpusStore {
  const corpusPath = resolveCorpusPath(options);
  const filePath = resolveCorpusFilePath(corpusPath);
  const recordsById = new Map<string, MemoryRecord>(loadRecords(filePath).map((record) => [record.id, record]));

  return {
    path: filePath,
    write(intent: WriteIntent): MemoryRecord {
      const normalized = normalizeWriteIntent(intent);
      const id = normalizeStableKey(normalized.scope, normalized.identity);
      const record = normalizeRecord({
        id,
        scope: normalized.scope,
        provenance: normalized.provenance ?? { source: 'shared-corpus', adapter: 'jsonl' },
        identity: normalized.identity,
        content: normalized.content,
        metadata: {
          createdAt: recordsById.get(id)?.metadata?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          sourcePath: filePath,
        },
      });
      recordsById.set(record.id, record);
      persistRecords(filePath, [...recordsById.values()]);
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
      persistRecords(filePath, [...recordsById.values()]);
      return removed;
    },
    close(): void {
      persistRecords(filePath, [...recordsById.values()]);
    },
  };
}

export { resolveCorpusPath };
