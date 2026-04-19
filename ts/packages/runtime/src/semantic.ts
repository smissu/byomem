import type { MemoryRecord } from './contracts.js';

export function semanticFingerprint(record: MemoryRecord): string {
  return JSON.stringify({
    source: record.provenance.source,
    structured: record.content.structured ?? {},
  });
}
