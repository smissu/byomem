import type { MemoryRecord } from './contracts.js';
import { semanticFingerprint } from './semantic.js';

export type SearchMode = 'lexical' | 'semantic' | 'hybrid';

export interface SearchScore {
  record: MemoryRecord;
  score: number;
  signals: {
    lexical: number;
    semantic: number;
    scope: number;
    provenance: number;
    context: number;
    recency: number;
  };
}

function tokenize(value: string): string[] {
  return value.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

export function lexicalScore(record: MemoryRecord, query: string): number {
  const haystack = [record.id, record.identity.namespace, record.identity.leafName, record.identity.parentContext ?? '', record.content.text ?? '']
    .join(' ')
    .toLowerCase();
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  if (haystack === needle) return 1;
  if (haystack.includes(needle)) return 0.8;
  const tokens = tokenize(needle);
  return tokens.length ? tokens.filter((token) => haystack.includes(token)).length / tokens.length : 0;
}

export function semanticScore(record: MemoryRecord, query: string): number {
  const structured = semanticFingerprint(record);
  const haystack = `${record.provenance.source} ${structured}`.toLowerCase();
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  return haystack.includes(needle) ? 0.5 : 0;
}

function scopeScore(record: MemoryRecord): number {
  return record.scope === 'project' ? 0.2 : record.scope === 'dir' ? 0.15 : record.scope === 'user' ? 0.1 : 0.05;
}

function provenanceScore(record: MemoryRecord): number {
  return record.provenance.origin ? 0.1 : 0.04;
}

function contextScore(record: MemoryRecord, query: string): number {
  const context = record.identity.parentContext?.toLowerCase() ?? '';
  const needle = query.trim().toLowerCase();
  if (!needle || !context) return 0;
  return context.includes(needle) ? 0.08 : 0;
}

function recencyScore(record: MemoryRecord): number {
  return record.metadata?.updatedAt ? 0.05 : 0;
}

function totalScore(signals: SearchScore['signals'], mode: SearchMode): number {
  if (mode === 'lexical') return signals.lexical + signals.scope + signals.context + signals.provenance + signals.recency;
  if (mode === 'semantic') return signals.semantic + signals.scope + signals.context + signals.provenance + signals.recency;
  return (signals.lexical * 0.6) + (signals.semantic * 0.25) + (signals.scope * 0.05) + (signals.provenance * 0.05) + (signals.context * 0.03) + (signals.recency * 0.02);
}

export function rankRecord(record: MemoryRecord, query: string, mode: SearchMode = 'hybrid'): SearchScore {
  const signals = {
    lexical: lexicalScore(record, query),
    semantic: semanticScore(record, query),
    scope: scopeScore(record),
    provenance: provenanceScore(record),
    context: contextScore(record, query),
    recency: recencyScore(record),
  };
  return { record, score: totalScore(signals, mode), signals };
}

export function rankRecords(records: MemoryRecord[], query: string, mode: SearchMode = 'hybrid'): SearchScore[] {
  const trimmedQuery = query.trim();
  const bestById = new Map<string, SearchScore>();
  for (const record of records) {
    const ranked = rankRecord(record, query, mode);
    const hasRelevantSignal = trimmedQuery.length === 0 || ranked.signals.lexical > 0 || ranked.signals.semantic > 0;
    if (!hasRelevantSignal) continue;
    const existing = bestById.get(record.id);
    if (!existing || ranked.score > existing.score || (ranked.score === existing.score && ranked.record.id.localeCompare(existing.record.id) < 0)) {
      bestById.set(record.id, ranked);
    }
  }

  return [...bestById.values()].sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id));
}
