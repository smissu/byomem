import type { MemoryRecord } from './contracts.js';

export function isCaptureCandidate(record: MemoryRecord, approved = false): boolean {
  return approved && Boolean(record.content.text || record.content.structured);
}
