import type { MemoryRecord } from './contracts.js';

function tokenize(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export function semanticFingerprint(record: MemoryRecord): string {
  return JSON.stringify({
    source: record.provenance.source,
    structured: record.content.structured ?? {},
    text: record.content.text ?? '',
  });
}

export function semanticScore(record: MemoryRecord, query: string): number {
  const fingerprint = semanticFingerprint(record).toLowerCase();
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  if (fingerprint.includes(needle)) return 0.5;
  const tokens = tokenize(needle);
  if (!tokens.length) return 0;
  const matches = tokens.filter((token) => fingerprint.includes(token)).length;
  return matches / tokens.length ? 0.5 * (matches / tokens.length) : 0;
}
