import type { MemoryRecord } from './contracts.js';

export interface ParityDiff {
  field: string;
  expected: unknown;
  actual: unknown;
}

export function compareRecords(expected: MemoryRecord, actual: MemoryRecord): ParityDiff[] {
  const diffs: ParityDiff[] = [];

  if (expected.id !== actual.id) diffs.push({ field: 'id', expected: expected.id, actual: actual.id });
  if (expected.scope !== actual.scope) diffs.push({ field: 'scope', expected: expected.scope, actual: actual.scope });
  if (expected.identity.namespace !== actual.identity.namespace) {
    diffs.push({ field: 'identity.namespace', expected: expected.identity.namespace, actual: actual.identity.namespace });
  }
  if (expected.identity.leafName !== actual.identity.leafName) {
    diffs.push({ field: 'identity.leafName', expected: expected.identity.leafName, actual: actual.identity.leafName });
  }
  if ((expected.identity.parentContext ?? null) !== (actual.identity.parentContext ?? null)) {
    diffs.push({ field: 'identity.parentContext', expected: expected.identity.parentContext ?? null, actual: actual.identity.parentContext ?? null });
  }
  if ((expected.metadata?.sourcePath ?? null) !== (actual.metadata?.sourcePath ?? null)) {
    diffs.push({ field: 'metadata.sourcePath', expected: expected.metadata?.sourcePath ?? null, actual: actual.metadata?.sourcePath ?? null });
  }
  if ((expected.provenance?.source ?? null) !== (actual.provenance?.source ?? null)) {
    diffs.push({ field: 'provenance.source', expected: expected.provenance?.source ?? null, actual: actual.provenance?.source ?? null });
  }

  return diffs;
}
